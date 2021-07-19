import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import bs58 from 'bs58'
import { ethers } from 'ethers'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof, urlParams, nearOnEthSyncHeight, findNearProof } from '@near-eth/utils'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider } from '@near-eth/client/dist/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/near-ether/natural-near/sendToEthereum'

const LOCK = 'lock-natural-near-to-e-near'
const AWAIT_FINALITY = 'await-finality-natural-near-to-e-near'
const SYNC = 'sync-natural-near-to-e-near'
const MINT = 'mint-natural-near-to-e-near'

const steps = [
  LOCK,
  AWAIT_FINALITY,
  SYNC,
  MINT
]

class TransferError extends Error {}

const transferDraft = {
  // Attributes common to all transfer types
  // amount,
  completedStep: null,
  // destinationTokenName,
  errors: [],
  // recipient,
  // sender,
  // sourceToken,
  // sourceTokenName,
  // decimals,
  status: status.IN_PROGRESS,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to bridged-nep141-to-erc20 transfers
  finalityBlockHeights: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  mintHashes: [],
  mintReceipts: [],
  lockReceiptBlockHeights: [],
  lockReceiptIds: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: 'Confirm in NEAR',
      [SYNC]: 'Confirm in Ethereum. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from NEAR'
          case SYNC: return 'Ready to deposit in Ethereum'
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Ethereum'
        case LOCK: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case MINT: return 'Transfer complete'
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
        case SYNC: return 'Deposit'
      }
    }
  }
}

/**
 * Called when status is ACTION_NEEDED or FAILED
 * @param {*} transfer
 */
export function act (transfer) {
  switch (transfer.completedStep) {
    case null: return lock(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return mint(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkLock(transfer)
    case LOCK: return checkFinality(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return checkMint(transfer)
  }
}

/**
 * Recover transfer from a lock tx hash
 * Track a new transfer at the completedStep = LOCK so that it can be minted
 * @param {string} lockTxHash Near tx hash containing the token lock
 * @param {string} sender Near account sender of lockTxHash
 */
export async function recover (lockTxHash, sender = 'todo') {
  const decodedTxHash = utils.serialize.base_decode(lockTxHash)
  const nearAccount = await getNearAccount()
  const lockTx = await nearAccount.connection.provider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = lockTx.transaction.signer_id

  if (lockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Lock transaction pending: ${lockTxHash}`)
  }

  // Check status of tx broadcasted by wallet
  if (lockTx.status.Failure) {
    throw new Error(`Lock transaction failed: ${lockTxHash}`)
  }

  // Get lock event information from successValue
  const successValue = lockTx.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid lockTx successValue: '${successValue}'
      Full lock transaction: ${JSON.stringify(lockTx)}`
    )
  }

  class LockEvent {
    constructor (args) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [LockEvent, {
      kind: 'struct',
      fields: [
        ['flag', 'u8'],
        ['amount', 'u128'],
        ['recipient', [20]]
      ]
    }]
  ])
  const lockEvent = deserializeBorsh(
    SCHEMA, LockEvent, Buffer.from(successValue, 'base64')
  )

  const amount = lockEvent.amount.toString()
  const recipient = '0x' + Buffer.from(lockEvent.recipient).toString('hex')
  const destinationTokenName = 'NEAR'
  const decimals = 24
  const sourceTokenName = 'NEAR'

  const lockReceipt = await parseLockReceipt(lockTx, sender)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    decimals,

    lockReceiptBlockHeights: [lockReceipt.blockHeight],
    lockReceiptIds: [lockReceipt.id]
  }

  // Check transfer status
  transfer = await checkSync(transfer)
  return transfer
}

/**
 * Parse the lock receipt id and block height needed to complete
 * the step LOCK
 * @param {*} lockTx
 * @param {string} sender
 */
async function parseLockReceipt (lockTx, sender) {
  const nearAccount = await getNearAccount()
  const receiptIds = lockTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Lock expects only one receipt, got ${receiptIds.length}.
      Full lock transaction: ${JSON.stringify(lockTx)}`
    )
  }

  // Get receipt information for recording and building lock proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = lockTx.receipts_outcome
    .find(r => r.id === txReceiptId).outcome
  const successReceiptId = successReceiptOutcome.status.SuccessReceiptId
  const successReceiptExecutorId = successReceiptOutcome.executor_id

  let lockReceiptId

  // Check if this tx was made from a 2fa
  switch (successReceiptExecutorId) {
    case sender: {
      // `confirm` transaction executed on 2fa account
      const lockReceiptOutcome = lockTx.receipts_outcome
        .find(r => r.id === successReceiptId)
        .outcome

      lockReceiptId = successReceiptId

      const lockReceiptExecutorId = lockReceiptOutcome.executor_id
      // Expect this receipt to be the 2fa FunctionCall
      if (lockReceiptExecutorId !== process.env.nativeNEARLockerAddress) {
        throw new TransferError(
          `Unexpected receipt outcome format in 2fa transaction.
          Expected sourceToken '${process.env.nativeNEARLockerAddress}', got '${lockReceiptExecutorId}'
          Full withdrawal transaction: ${JSON.stringify(lockTx)}`
        )
      }
      break
    }
    case process.env.nativeNEARLockerAddress:
      // `lock` called directly, successReceiptId is already correct, nothing to do
      lockReceiptId = txReceiptId
      break
    default:
      throw new TransferError(
        `Unexpected receipt outcome format.
        Full withdrawal transaction: ${JSON.stringify(lockTx)}`
      )
  }

  const txReceiptBlockHash = lockTx.receipts_outcome
    .find(r => r.id === lockReceiptId).block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: lockReceiptId, blockHeight: receiptBlockHeight }
}

/**
 * Create a new transfer.
 */
export async function initiate ({
  amount,
  sender,
  recipient
}) {
  // TODO: move to core 'decorate'; get both from contracts
  const destinationTokenName = 'NEAR'
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = 24
  const sourceTokenName = 'NEAR'

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: (new Decimal(amount).times(10 ** decimals)).toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    decimals
  }
  // Prevent checkStatus from creating failed transfer when called between track and lock
  urlParams.set({ locking: 'processing' })

  transfer = await track(transfer)

  await lock(transfer)
}

/**
 * Lock native NEAR to migrate to Ethereum.
 * @param {*} transfer
 */
async function lock (transfer) {
  const nearAccount = await getNearAccount()

  urlParams.set({ locking: transfer.id })

  setTimeout(async () => {
    await nearAccount.functionCall(
      process.env.nativeNEARLockerAddress,
      'migrate_to_ethereum',
      {
        eth_recipient: transfer.recipient.replace('0x', '')
      },
      new BN('10' + '0'.repeat(12)), // 10TGas
      new BN(transfer.amount)
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted lock transaction
 * checkLock is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkLock can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkLock (transfer) {
  const id = urlParams.get('locking')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A lock transaction was initiated but could not be verified.
      If a transaction was sent from your account, please make sure to 'Restore transfer' and finalize it.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id || id === 'processing') {
    console.log('Waiting for Near wallet redirect to sign lock')
    return transfer
  }
  if (id !== transfer.id) {
    // Another lock transaction cannot be in progress, ie if checkLock is called on
    // an in process lock then the transfer ids must be equal or the url callback is invalid.
    urlParams.clear()
    const newError = `Couldn't determine transaction outcome.
      Got transfer id '${id} in URL, expected '${transfer.id}`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (errorCode) {
    // If errorCode, then the redirect succeded but the tx was rejected/failed
    // so clear url params
    urlParams.clear()
    const newError = 'Error from wallet: ' + errorCode
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!txHash) {
    // If checkLock is called before lock sig wallet redirect
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Lock tx hash not received: pending redirect or wallet error'
    console.log(newError)
    return transfer
  }
  if (txHash.includes(',')) {
    urlParams.clear()
    const newError = 'Error from wallet: expected single txHash, got: ' + txHash
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }

  const decodedTxHash = utils.serialize.base_decode(txHash)
  const nearAccount = await getNearAccount()
  const lockTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a lock
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  if (lockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (lockTx.status.Failure) {
    urlParams.clear()
    console.error('lockTx.status.Failure', lockTx.status.Failure)
    const errorMessage = typeof lockTx.status.Failure === 'object'
      ? parseRpcError(lockTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${lockTx.transaction.hash}">${lockTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      lockTx
    }
  }

  let lockReceipt
  try {
    lockReceipt = await parseLockReceipt(lockTx, transfer.sender)
  } catch (e) {
    if (e instanceof TransferError) {
      urlParams.clear()
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        lockTx
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkLock will be called again.
    throw e
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    lockReceiptIds: [...transfer.lockReceiptIds, lockReceipt.id],
    lockReceiptBlockHeights: [...transfer.lockReceiptBlockHeights, lockReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than lockTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 * @param {*} transfer
 */
async function checkFinality (transfer) {
  const nearAccount = await getNearAccount()

  const lockReceiptBlockHeight = last(transfer.lockReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= lockReceiptBlockHeight) {
    return transfer
  }

  return {
    ...transfer,
    completedStep: AWAIT_FINALITY,
    status: status.IN_PROGRESS,
    finalityBlockHeights: [...transfer.finalityBlockHeights, latestFinalizedBlock]
  }
}

/**
 * Wait for the block with the given receipt/transaction in Near2EthClient, and
 * get the outcome proof only use block merkle root that we know is available
 * on the Near2EthClient.
 * @param {*} transfer
 */
async function checkSync (transfer) {
  if (!transfer.checkSyncInterval) {
    // checkSync every 60s: reasonable value to detect transfer is ready to be finalized
    transfer = {
      ...transfer,
      checkSyncInterval: Number(process.env.sendToEthereumSyncInterval)
    }
  }
  if (transfer.nextCheckSyncTimestamp && new Date() < new Date(transfer.nextCheckSyncTimestamp)) {
    return transfer
  }
  const provider = getEthProvider()
  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    console.log(
      'Wrong eth network for checkSync, expected: %s, got: %s',
      process.env.ethChainId, ethChainId
    )
    return transfer
  }

  const lockReceiptBlockHeight = last(transfer.lockReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(provider)
  let proof

  if (nearOnEthClientBlockHeight > lockReceiptBlockHeight) {
    proof = await findNearProof(
      last(transfer.lockReceiptIds),
      transfer.sender,
      nearOnEthClientBlockHeight,
      await getNearAccount(),
      provider
    )
    if (await proofAlreadyUsed(provider, proof)) {
      // TODO find the unlockTxHash
      return {
        ...transfer,
        completedStep: MINT,
        nearOnEthClientBlockHeight,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Mint proof already used.']
      }
    }
  } else {
    return {
      ...transfer,
      nextCheckSyncTimestamp: new Date(Date.now() + transfer.checkSyncInterval),
      nearOnEthClientBlockHeight,
      status: status.IN_PROGRESS
    }
  }

  return {
    ...transfer,
    completedStep: SYNC,
    nearOnEthClientBlockHeight,
    status: status.ACTION_NEEDED,
    proof // used when checkSync() is called by unlock()
  }
}

/**
 * Check if a NEAR outcome receipt_id has already been used to finalize a transfer to Ethereum.
 * @param {*} provider
 * @param {*} proof
 */
async function proofAlreadyUsed (provider, proof) {
  const usedProofsKey = bs58.decode(proof.outcome_proof.outcome.receipt_ids[0]).toString('hex')
  // The usedProofs_ mapping is the 9th variable defined in the contract storage.
  const usedProofsMappingPosition = '0'.repeat(63) + '8'
  const storageIndex = ethers.utils.keccak256('0x' + usedProofsKey + usedProofsMappingPosition)
  // eth_getStorageAt docs: https://eth.wiki/json-rpc/API
  const proofIsUsed = await provider.getStorageAt(process.env.eNEARAddress, storageIndex)
  return Number(proofIsUsed) === 1
}

/**
 * Mint eNEAR tokens,
 * passing the proof that the tokens were locked in the corresponding
 * NEAR BridgeToken contract.
 * @param {*} transfer
 */
async function mint (transfer) {
  const provider = getSignerProvider()

  // Build lock proof
  transfer = await checkSync(transfer)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const borshProof = borshifyOutcomeProof(proof)

  const eNEAR = new ethers.Contract(
    process.env.eNEARAddress,
    process.env.eNEARAbiText,
    provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingMintTx = await eNEAR.finaliseNearToEthTransfer(borshProof, transfer.nearOnEthClientBlockHeight)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingMintTx.from,
      to: pendingMintTx.to,
      safeReorgHeight,
      data: pendingMintTx.data,
      nonce: pendingMintTx.nonce
    },
    mintHashes: [...transfer.mintHashes, pendingMintTx.hash]
  }
}

async function checkMint (transfer) {
  const provider = getEthProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    console.log(
      'Wrong eth network for checkMint, expected: %s, got: %s',
      process.env.ethChainId, ethChainId
    )
    return transfer
  }

  const mintHash = last(transfer.mintHashes)
  let mintReceipt = await provider.getTransactionReceipt(mintHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!mintReceipt) {
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      mintReceipt = await provider.getTransactionReceipt(foundTx.hash)
    } catch (error) {
      console.error(error)
      if (error instanceof TxValidationError) {
        return {
          ...transfer,
          errors: [...transfer.errors, error.message],
          status: status.FAILED
        }
      }
      throw error
    }
  }

  if (!mintReceipt) return transfer

  if (!mintReceipt.status) {
    const error = `Transaction failed: ${mintReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      mintReceipts: [...transfer.mintReceipts, mintReceipt]
    }
  }

  if (mintReceipt.transactionHash !== mintHash) {
    // Record the replacement tx mintHash
    return {
      ...transfer,
      status: status.COMPLETE,
      completedStep: MINT,
      mintHashes: [...transfer.mintHashes, mintReceipt.transactionHash],
      mintReceipts: [...transfer.mintReceipts, mintReceipt]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: MINT,
    mintReceipts: [...transfer.mintReceipts, mintReceipt]
  }
}

const last = arr => arr[arr.length - 1]

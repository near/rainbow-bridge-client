import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import bs58 from 'bs58'
import { ethers } from 'ethers'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import {
  deserialize as deserializeBorsh,
  serialize as serializeBorsh
} from 'near-api-js/lib/utils/serialize'
import * as status from '@near-eth/client/dist/statuses'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import { track } from '@near-eth/client'
import { borshifyOutcomeProof, urlParams, nearOnEthSyncHeight, findNearProof } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider } from '@near-eth/client/dist/utils'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/near-ether/bridged-ether/sendToEthereum'

const BURN = 'burn-bridged-ether-to-natural-ether'
const AWAIT_FINALITY = 'await-finality-bridged-ether-to-natural-ether'
const SYNC = 'sync-bridged-ether-to-natural-ether'
const UNLOCK = 'unlock-bridged-ether-to-natural-ether'

const steps = [
  BURN,
  AWAIT_FINALITY,
  SYNC,
  UNLOCK
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
  unlockHashes: [],
  unlockReceipts: [],
  burnReceiptBlockHeights: [],
  burnReceiptIds: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from NEAR`,
      [AWAIT_FINALITY]: 'Confirm in NEAR',
      [SYNC]: 'Confirm in Ethereum. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Ethereum`
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
        case null: return 'Transfering from NEAR'
        case BURN: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case UNLOCK: return 'Transfer complete'
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
    case null: return burn(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return unlock(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkBurn(transfer)
    case BURN: return checkFinality(transfer)
    case AWAIT_FINALITY: return checkSync(transfer)
    case SYNC: return checkUnlock(transfer)
  }
}

/**
 * Recover transfer from a burn tx hash
 * Track a new transfer at the completedStep = BURN so that it can be unlocked
 * @param {string} burnTxHash Near tx hash containing the token withdrawal
 * @param {string} sender Near account sender of burnTxHash
 */
export async function recover (burnTxHash, sender = 'todo') {
  const decodedTxHash = utils.serialize.base_decode(burnTxHash)
  const nearAccount = await getNearAccount()
  const burnTx = await nearAccount.connection.provider.txStatus(
    // TODO: when multiple shards, the sender should be known in order to query txStatus
    decodedTxHash, sender
  )
  sender = burnTx.transaction.signer_id

  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Burn transaction pending: ${burnTxHash}`)
  }

  // Check status of tx broadcasted by wallet
  if (burnTx.status.Failure) {
    throw new Error(`Burn transaction failed: ${burnTxHash}`)
  }

  // Get burn event information from successValue
  const successValue = burnTx.status.SuccessValue
  if (!successValue) {
    throw new Error(
      `Invalid burnTx successValue: '${successValue}'
      Full withdrawal transaction: ${JSON.stringify(burnTx)}`
    )
  }

  class WithdrawEvent {
    constructor (args) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [WithdrawEvent, {
      kind: 'struct',
      fields: [
        ['amount', 'u128'],
        ['recipient_id', [20]],
        ['eth_custodian_address', [20]]
      ]
    }]
  ])
  const withdrawEvent = deserializeBorsh(
    SCHEMA, WithdrawEvent, Buffer.from(successValue, 'base64')
  )

  const amount = withdrawEvent.amount.toString()
  const recipient = '0x' + Buffer.from(withdrawEvent.recipient_id).toString('hex')
  const etherCustodian = '0x' + Buffer.from(withdrawEvent.eth_custodian_address).toString('hex')
  if (etherCustodian !== process.env.etherCustodianAddress.toLowerCase()) {
    throw new Error('Failed to verify ETH custodian address.')
  }
  const destinationTokenName = 'ETH'
  const decimals = 18
  const sourceTokenName = 'n' + destinationTokenName

  const withdrawReceipt = await parseWithdrawReceipt(burnTx, sender, process.env.auroraEvmAccount)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount,
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender,
    sourceTokenName,
    decimals,

    burnReceiptBlockHeights: [withdrawReceipt.blockHeight],
    burnReceiptIds: [withdrawReceipt.id]
  }

  // Check transfer status
  transfer = await checkSync(transfer)
  return transfer
}

/**
 * Parse the burn receipt id and block height needed to complete
 * the step BURN
 * @param {*} burnTx
 * @param {string} sender
 * @param {string} sourceToken
 */
async function parseWithdrawReceipt (burnTx, sender, sourceToken) {
  const nearAccount = await getNearAccount()
  const receiptIds = burnTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Withdrawal expects only one receipt, got ${receiptIds.length}.
      Full withdrawal transaction: ${JSON.stringify(burnTx)}`
    )
  }

  // Get receipt information for recording and building burn proof
  const successReceiptId = receiptIds[0]
  const successReceiptOutcome = burnTx.receipts_outcome
    .find(r => r.id === successReceiptId).outcome
  // const successReceiptId = successReceiptOutcome.status.SuccessReceiptId
  const successReceiptExecutorId = successReceiptOutcome.executor_id

  let withdrawReceiptId

  // Check if this tx was made from a 2fa
  switch (successReceiptExecutorId) {
    case sender: {
      // `confirm` transaction executed on 2fa account
      withdrawReceiptId = successReceiptOutcome.status.SuccessReceiptId
      const withdrawReceiptOutcome = burnTx.receipts_outcome
        .find(r => r.id === withdrawReceiptId)
        .outcome

      const withdrawReceiptExecutorId = withdrawReceiptOutcome.executor_id
      // Expect this receipt to be the 2fa FunctionCall
      if (withdrawReceiptExecutorId !== sourceToken) {
        throw new TransferError(
          `Unexpected receipt outcome format in 2fa transaction.
          Expected sourceToken '${sourceToken}', got '${withdrawReceiptExecutorId}'
          Full withdrawal transaction: ${JSON.stringify(burnTx)}`
        )
      }
      break
    }
    case sourceToken:
      // `burn` called directly, successReceiptId is already correct, nothing to do
      withdrawReceiptId = successReceiptId
      break
    default:
      throw new TransferError(
        `Unexpected receipt outcome format.
        Full withdrawal transaction: ${JSON.stringify(burnTx)}`
      )
  }

  const txReceiptBlockHash = burnTx.receipts_outcome
    .find(r => r.id === withdrawReceiptId).block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: withdrawReceiptId, blockHeight: receiptBlockHeight }
}

export async function initiate ({
  erc20Address,
  amount,
  sender,
  recipient
}) {
  const destinationTokenName = 'ETH'
  const decimals = 18
  const sourceTokenName = 'n' + destinationTokenName
  const sourceToken = process.env.auroraEvmAccount

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: (new Decimal(amount).times(10 ** decimals)).toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken,
    sourceTokenName,
    decimals
  }

  // Prevent checkStatus from creating failed transfer when called between track and burn
  urlParams.set({ withdrawing: 'processing' })

  transfer = await track(transfer)

  await burn(transfer)
}

async function burn (transfer) {
  const nearAccount = await getNearAccount()
  // Set url params before this burn() returns, otherwise there is a chance that checkBurn() is called before
  // the wallet redirect and the transfer errors because the status is IN_PROGRESS but the expected
  // url param is not there
  urlParams.set({ withdrawing: transfer.id })

  // Calling `BridgeToken.burn` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `burn` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkBurn` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(async () => {
    class BorshWithdrawArgs {
      constructor (args) {
        Object.assign(this, args)
      }
    };
    const withdrawCallArgsSchema = new Map([
      [BorshWithdrawArgs, {
        kind: 'struct',
        fields: [
          ['recipient_id', [20]],
          ['amount', 'u128']
          // TODO
          // ['fee', 'u128']
        ]
      }]
    ])
    const args = new BorshWithdrawArgs({
      recipient_id: ethers.utils.arrayify(ethers.utils.getAddress(transfer.recipient)),
      amount: transfer.amount.toString()
      // fee: fee.toString(),
    })
    const serializedArgs = serializeBorsh(withdrawCallArgsSchema, args)
    await nearAccount.functionCall(
      transfer.sourceToken,
      'withdraw',
      serializedArgs,
      // 100Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('100' + '0'.repeat(12)),
      new BN('1')
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted burn transaction
 * checkBurn is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkBurn can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkBurn (transfer) {
  const id = urlParams.get('withdrawing')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A withdraw transaction was initiated but could not be verified.
      If a transaction was sent from your account, please make sure to 'Restore transfer' and finalize it.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id || id === 'processing') {
    console.log('Waiting for Near wallet redirect to sign burn')
    return transfer
  }
  if (id !== transfer.id) {
    // Another burn transaction cannot be in progress, ie if checkBurn is called on
    // an in process burn then the transfer ids must be equal or the url callback is invalid.
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
    // If checkBurn is called before burn sig wallet redirect
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Burn tx hash not received: pending redirect or wallet error'
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
  const burnTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a burn
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (burnTx.status.Failure) {
    urlParams.clear()
    console.error('burnTx.status.Failure', burnTx.status.Failure)
    const errorMessage = typeof burnTx.status.Failure === 'object'
      ? parseRpcError(burnTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${burnTx.transaction.hash}">${burnTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      burnTx
    }
  }

  let withdrawReceipt
  try {
    withdrawReceipt = await parseWithdrawReceipt(burnTx, transfer.sender, transfer.sourceToken)
  } catch (e) {
    if (e instanceof TransferError) {
      urlParams.clear()
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED,
        burnTx
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkBurn will be called again.
    throw e
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    burnReceiptIds: [...transfer.burnReceiptIds, withdrawReceipt.id],
    burnReceiptBlockHeights: [...transfer.burnReceiptBlockHeights, withdrawReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than burnTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 * @param {*} transfer
 */
async function checkFinality (transfer) {
  const nearAccount = await getNearAccount()

  const withdrawReceiptBlockHeight = last(transfer.burnReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= withdrawReceiptBlockHeight) {
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

  const withdrawBlockHeight = last(transfer.burnReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(provider)
  let proof

  if (nearOnEthClientBlockHeight > withdrawBlockHeight) {
    proof = await findNearProof(
      last(transfer.burnReceiptIds),
      transfer.sender,
      nearOnEthClientBlockHeight,
      await getNearAccount(),
      provider
    )
    if (await proofAlreadyUsed(provider, proof)) {
      // TODO find the unlockTxHash
      return {
        ...transfer,
        completedStep: UNLOCK,
        nearOnEthClientBlockHeight,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Unlock proof already used.']
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
  // The usedProofs_ mapping is the 4th variable defined in the contract storage.
  const usedProofsMappingPosition = '0'.repeat(63) + '3'
  const storageIndex = ethers.utils.keccak256('0x' + usedProofsKey + usedProofsMappingPosition)
  // eth_getStorageAt docs: https://eth.wiki/json-rpc/API
  const proofIsUsed = await provider.getStorageAt(process.env.etherCustodianAddress, storageIndex)
  return Number(proofIsUsed) === 1
}

/**
 * Unlock tokens stored in the contract at process.env.ethLockerAddress,
 * passing the proof that the tokens were withdrawn/burned in the corresponding
 * NEAR BridgeToken contract.
 * @param {*} transfer
 */
async function unlock (transfer) {
  const provider = getSignerProvider()

  // Build burn proof
  transfer = await checkSync(transfer)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  const borshProof = borshifyOutcomeProof(proof)

  const ethTokenLocker = new ethers.Contract(
    process.env.etherCustodianAddress,
    process.env.etherCustodianAbiText,
    provider.getSigner()
  )
  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingUnlockTx = await ethTokenLocker.withdraw(borshProof, transfer.nearOnEthClientBlockHeight)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingUnlockTx.from,
      to: pendingUnlockTx.to,
      nonce: pendingUnlockTx.nonce,
      data: pendingUnlockTx.data,
      safeReorgHeight
    },
    unlockHashes: [...transfer.unlockHashes, pendingUnlockTx.hash]
  }
}

async function checkUnlock (transfer) {
  const provider = getEthProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    console.log(
      'Wrong eth network for checkUnlock, expected: %s, got: %s',
      process.env.ethChainId, ethChainId
    )
    return transfer
  }

  const unlockHash = last(transfer.unlockHashes)
  let unlockReceipt = await provider.getTransactionReceipt(unlockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!unlockReceipt) {
    // don't break old transfers in case they were made before this functionality is released
    if (!transfer.ethCache) return transfer
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      unlockReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!unlockReceipt) return transfer

  if (!unlockReceipt.status) {
    const error = `Transaction failed: ${unlockReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
    }
  }

  if (unlockReceipt.transactionHash !== unlockHash) {
    // Record the replacement tx unlockHash
    transfer = {
      ...transfer,
      unlockHashes: [...transfer.unlockHashes, unlockReceipt.transactionHash]
    }
  }

  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: UNLOCK,
    unlockReceipts: [...transfer.unlockReceipts, unlockReceipt]
  }
}

const last = arr => arr[arr.length - 1]

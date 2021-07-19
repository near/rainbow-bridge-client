import { borshifyOutcomeProof, nearOnEthSyncHeight, findNearProof } from '@near-eth/utils'
import { ethers } from 'ethers'
import bs58 from 'bs58'
import { utils } from 'near-api-js'
import {
  deserialize as deserializeBorsh
} from 'near-api-js/lib/utils/serialize'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import {
  getSignerProvider,
  getAuroraProvider,
  getEthProvider,
  getNearAccount,
  formatLargeNum
} from '@near-eth/client/dist/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'aurora'
export const DESTINATION_NETWORK = 'ethereum'
export const TRANSFER_TYPE = '@near-eth/aurora-ether/bridged-ether/sendToEthereum'

const BURN = 'burn-bridged-ether-to-ethereum'
const AWAIT_FINALITY = 'await-finality-bridged-ether-to-ethereum'
const SYNC = 'sync-bridged-ether-to-ethereum'
const UNLOCK = 'unlock-bridged-ether-to-ethereum'

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
  // sourceToken: erc20Address,
  // sourceTokenName,
  // symbol,
  // decimals,
  status: status.ACTION_NEEDED,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  //   data                     // tx.data of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  finalityBlockHeights: [],
  nearOnEthClientBlockHeight: null, // calculated & set to a number during checkSync
  burnHashes: [],
  burnReceipts: [],
  nearBurnHashes: [],
  nearBurnReceiptIds: [],
  nearBurnReceiptBlockHeights: [],
  unlockHashes: [],
  unlockReceipts: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Aurora`,
      [AWAIT_FINALITY]: 'Confirming in Aurora',
      [SYNC]: 'Confirming in Aurora. This can take around 16 hours. Feel free to return to this window later, to complete the final step of the transfer.',
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Ethereum`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Aurora'
          case SYNC: return 'Ready to deposit in Ethereum'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Ethereum'
        case BURN: return 'Confirming transfer'
        case AWAIT_FINALITY: return 'Confirming transfer'
        case SYNC: return 'Depositing in Ethereum'
        case UNLOCK: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case null: return 'Transfer'
        case SYNC: return 'Deposit'
        default: return null
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
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
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
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Parse the burn receipt id and block height needed to complete
 * the step BURN
 * @param {*} nearBurnTx
 */
async function parseBurnReceipt (nearBurnTx) {
  const nearAccount = await getNearAccount()
  const receiptIds = nearBurnTx.transaction_outcome.outcome.receipt_ids

  if (receiptIds.length !== 1) {
    throw new TransferError(
      `Burn expects only one receipt, got ${receiptIds.length}.
      Full withdrawal transaction: ${JSON.stringify(nearBurnTx)}`
    )
  }

  // Get receipt information for recording and building burn proof
  const txReceiptId = receiptIds[0]
  const successReceiptOutcome = nearBurnTx.receipts_outcome
    .find(r => r.id === txReceiptId).outcome
  const burnReceiptId = successReceiptOutcome.receipt_ids[0]

  const txReceiptBlockHash = nearBurnTx.receipts_outcome
    .find(r => r.id === burnReceiptId).block_hash

  const receiptBlock = await nearAccount.connection.provider.block({
    blockId: txReceiptBlockHash
  })
  const receiptBlockHeight = Number(receiptBlock.header.height)
  return { id: burnReceiptId, blockHeight: receiptBlockHeight }
}

/**
 * Recover transfer from a burn tx hash
 * @param {*} auroraBurnTxHash
 */
export async function recover (auroraBurnTxHash, sender = process.env.auroraRelayerAccount) {
  const provider = getAuroraProvider()

  // Ethers formats the receipts and removes nearTransactionHash
  const auroraBurnReceipt = await provider.send('eth_getTransactionReceipt', [auroraBurnTxHash])
  const nearBurnTxHash = bs58.encode(Buffer.from(auroraBurnReceipt.nearTransactionHash.slice(2), 'hex'))

  const decodedTxHash = utils.serialize.base_decode(nearBurnTxHash)
  const nearAccount = await getNearAccount()
  const burnTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, sender
  )

  if (burnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    throw new Error(`Withdraw transaction pending: ${nearBurnTxHash}`)
  }

  // Check status of tx broadcasted by relayer
  if (burnTx.status.Failure) {
    throw new Error(`Withdraw transaction failed: ${nearBurnTxHash}`)
  }

  class BurnEvent {
    constructor (args) {
      Object.assign(this, args)
    }
  }
  const SCHEMA = new Map([
    [BurnEvent, {
      kind: 'struct',
      fields: [
        ['amount', 'u128'],
        ['recipient_id', [20]],
        ['eth_custodian_address', [20]]
      ]
    }]
  ])
  const withdrawResult = burnTx.receipts_outcome[1].outcome.status.SuccessValue
  const burnEvent = deserializeBorsh(
    SCHEMA, BurnEvent, Buffer.from(withdrawResult, 'base64')
  )

  const amount = burnEvent.amount.toString()
  const recipient = '0x' + Buffer.from(burnEvent.recipient_id).toString('hex')
  const ethCustodianAddress = Buffer.from(burnEvent.eth_custodian_address).toString('hex')

  if (ethCustodianAddress !== process.env.etherCustodianAddress.slice(2).toLowerCase()) {
    throw new Error(
      `Unexpected ether custodian: got${ethCustodianAddress},
      expected ${process.env.etherCustodianAddress}`
    )
  }

  const destinationTokenName = 'ETH'
  const decimals = 18
  const sourceTokenName = 'a' + destinationTokenName
  const symbol = 'ETH'
  const sourceToken = null

  const nearBurnReceipt = await parseBurnReceipt(burnTx)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount,
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender: auroraBurnReceipt.from, // TODO get sender from receipt event (to handle multisig)
    sourceToken,
    sourceTokenName,
    symbol,
    decimals,

    burnHashes: [auroraBurnReceipt.transactionHash],
    nearBurnHashes: [nearBurnTxHash],
    burnReceipts: [auroraBurnReceipt],
    nearBurnReceiptIds: [nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [nearBurnReceipt.blockHeight]
  }

  // Check transfer status
  transfer = await checkSync(transfer)
  return transfer
}

export async function initiate ({ amount, token }) {
  const sourceTokenName = 'a' + token.symbol
  const decimals = token.decimals
  const destinationTokenName = token.symbol

  // TODO enable different recipient and consider multisig case where sender is not the signer
  const provider = getSignerProvider()
  const sender = (await provider.getSigner().getAddress()).toLowerCase()
  const recipient = sender

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: amount,
    destinationTokenName,
    recipient,
    sender,
    sourceToken: token.auroraAddress, // null
    sourceTokenName,
    symbol: token.symbol,
    decimals
  }

  transfer = await burn(transfer)
  return track(transfer)
}

/**
 * Initiate "burn" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 * @param {*} transfer
 */
async function burn (transfer) {
  const provider = getSignerProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.auroraChainId)) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for burn, expected: ${process.env.auroraChainId}, got: ${ethChainId}`
    )
  }

  const safeReorgHeight = await provider.getBlockNumber() - 20
  const exitToEthereumData = '0x00' + transfer.recipient.slice(2)
  const txHash = await provider.send('eth_sendTransaction', [{
    from: transfer.sender,
    to: process.env.exitToEthereumPrecompile,
    value: ethers.BigNumber.from(transfer.amount).toHexString(),
    data: exitToEthereumData,
    gas: ethers.BigNumber.from(121000).toHexString()
  }])
  const pendingBurnTx = await provider.getTransaction(txHash)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce,
      value: pendingBurnTx.value.toString(),
      safeReorgHeight
    },
    burnHashes: [...transfer.burnHashes, txHash]
  }
}

async function checkBurn (transfer) {
  const provider = getAuroraProvider()

  const burnHash = last(transfer.burnHashes)

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.auroraChainId)) {
    console.log(
      `Wrong eth network for checkBurn, expected: ${process.env.auroraChainId}, got: ${ethChainId}`
    )
    return transfer
  }
  // Ethers formats the receipts and removes nearTransactionHash
  let burnReceipt = await provider.send('eth_getTransactionReceipt', [burnHash])

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
    return transfer // TODO remove when speed up available on Aurora
    // eslint-disable-next-line no-unreachable
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        // TODO check data is valid when Aurora rpc is complete and contains tx.input (currently "0x")
        // data: transfer.ethCache.data,
        value: transfer.ethCache.value
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      // Ethers formats the receipts and removes nearTransactionHash
      burnReceipt = await provider.send('eth_getTransactionReceipt', [foundTx.hash])
    } catch (error) {
      console.error(error)
      if (error instanceof TxValidationError) {
        return {
          ...transfer,
          errors: [...transfer.errors, error.message],
          status: status.FAILED
        }
      }
    }
  }

  if (!burnReceipt) return transfer

  if (burnReceipt.status !== '0x1') {
    const error = `Aurora transaction failed: ${burnReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }
  if (burnReceipt.transactionHash !== burnHash) {
    // Record the replacement tx burnHash
    transfer = {
      ...transfer,
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  // Parse NEAR tx burn receipt
  const decodedTxHash = Buffer.from(burnReceipt.nearTransactionHash.slice(2), 'hex')
  const nearBurnHash = bs58.encode(decodedTxHash)

  const nearAccount = await getNearAccount()
  const nearBurnTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, process.env.auroraRelayerAccount
  )

  if (nearBurnTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (nearBurnTx.status.Failure) {
    const error = 'NEAR relay.aurora transaction failed.'
    return {
      ...transfer,
      errors: [...transfer.errors, error],
      status: status.FAILED
    }
  }

  let nearBurnReceipt
  try {
    nearBurnReceipt = await parseBurnReceipt(nearBurnTx)
  } catch (e) {
    if (e instanceof TransferError) {
      return {
        ...transfer,
        errors: [...transfer.errors, e.message],
        status: status.FAILED
      }
    }
    // Any other error like provider connection error should throw
    // so that the transfer stays in progress and checkWithdraw will be called again.
    throw e
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    burnReceipts: [...transfer.burnReceipts, burnReceipt],
    nearBurnHashes: [...transfer.nearBurnHashes, nearBurnHash],
    nearBurnReceiptIds: [...transfer.nearBurnReceiptIds, nearBurnReceipt.id],
    nearBurnReceiptBlockHeights: [...transfer.nearBurnReceiptBlockHeights, nearBurnReceipt.blockHeight]
  }
}

/**
 * Wait for a final block with a strictly greater height than nearBurnTx
 * receipt. This block (or one of its ancestors) should hold the outcome.
 * Although this may not support sharding.
 * TODO: support sharding
 * @param {*} transfer
 */
async function checkFinality (transfer) {
  const nearAccount = await getNearAccount()

  const burnReceiptBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const latestFinalizedBlock = Number((
    await nearAccount.connection.provider.block({ finality: 'final' })
  ).header.height)

  if (latestFinalizedBlock <= burnReceiptBlockHeight) {
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

  const burnBlockHeight = last(transfer.nearBurnReceiptBlockHeights)
  const nearOnEthClientBlockHeight = await nearOnEthSyncHeight(provider)
  let proof

  if (nearOnEthClientBlockHeight > burnBlockHeight) {
    proof = await findNearProof(
      last(transfer.nearBurnReceiptIds),
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
 * Unlock tokens stored in the contract at process.env.etherCustodianAddress,
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

  // Unlock
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

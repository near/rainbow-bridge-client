import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getSignerProvider, getNearAccount, formatLargeNum } from '@near-eth/client/dist/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import { ethOnNearSyncHeight, findEthProof } from '@near-eth/utils'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-ether/natural-ether/sendToAurora'

const LOCK = 'lock-natural-ether-to-aurora'
const SYNC = 'sync-natural-ether-to-aurora'
const MINT = 'mint-natural-ether-to-aurora'

const steps = [
  LOCK,
  SYNC,
  MINT
]

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
  // decimals,
  status: status.ACTION_NEEDED,
  type: TRANSFER_TYPE,
  // Cache eth tx information used for finding a replaced (speedup/cancel) tx.
  // ethCache: {
  //   from,                     // tx.from of last broadcasted eth tx
  //   to,                       // tx.to of last broadcasted eth tx (can be multisig contract)
  //   safeReorgHeight,          // Lower boundary for replacement tx search
  //   nonce                     // tx.nonce of last broadcasted eth tx
  // }

  // Attributes specific to natural-erc20-to-nep141 transfers
  completedConfirmations: 0,
  lockHashes: [],
  lockReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  mintHashes: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in Aurora`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case null: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to Aurora'
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations}`
        case SYNC: return 'Depositing in Aurora'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
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
    case null: return lock(transfer)
    case LOCK: return checkSync(transfer)
    // case SYNC: return mint(transfer) // Not implemented, done by relayer
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkLock(transfer)
    case LOCK: return checkSync(transfer)
    // case SYNC: return checkMint(transfer) // Not implemented, done by relayer
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a lock tx hash
 * @param {*} lockTxHash
 */
export async function recover (lockTxHash) {
  const provider = getEthProvider()

  const receipt = await provider.getTransactionReceipt(lockTxHash)
  const ethTokenLocker = new ethers.Contract(
    process.env.etherCustodianAddress,
    process.env.etherCustodianAbiText,
    provider
  )
  const filter = ethTokenLocker.filters.Deposited()
  const events = await ethTokenLocker.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const lockedEvent = events.find(event => event.transactionHash === lockTxHash)
  if (!lockedEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const sender = lockedEvent.args.sender
  const protocolMessage = lockedEvent.args.recipient
  const [auroraEvmAccount, auroraRecipient] = protocolMessage.split(':')
  if (auroraEvmAccount !== process.env.auroraEvmAccount) {
    throw new Error('Failed to parse auroraEvmAccount in protocol message')
  }
  if (!/^([A-Fa-f0-9]{40})$/.test(auroraRecipient)) {
    throw new Error('Failed to parse recipient in protocol message')
  }
  const amount = lockedEvent.args.amount.toString()
  const sourceTokenName = 'ETH'
  const decimals = 18
  const destinationTokenName = 'a' + sourceTokenName
  const symbol = 'ETH'

  let transfer = {
    ...transferDraft,

    id: new Date().toISOString(),
    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient: '0x' + auroraRecipient,
    sender,
    sourceToken: null,
    sourceTokenName,
    symbol,
    decimals,
    status: status.IN_PROGRESS,
    lockHashes: [lockTxHash],
    lockReceipts: [receipt]
  }
  // Check transfer status
  transfer = await checkSync(transfer)
  return transfer
}

export async function initiate ({ amount, token }) {
  const sourceTokenName = token.symbol
  const decimals = token.decimals
  const destinationTokenName = 'a' + sourceTokenName

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
    sourceToken: token.ethAddress, // null
    sourceTokenName,
    symbol: token.symbol,
    decimals
  }

  transfer = await lock(transfer)

  return track(transfer)
}

/**
 * Initiate "lock" transaction.
 * Only wait for transaction to have dependable transactionHash created. Avoid
 * blocking to wait for transaction to be mined. Status of transactionHash
 * being mined is then checked in checkStatus.
 * @param {*} transfer
 */
async function lock (transfer) {
  const provider = getSignerProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for lock, expected: ${process.env.ethChainId}, got: ${ethChainId}`
    )
  }

  const ethTokenLocker = new ethers.Contract(
    process.env.etherCustodianAddress,
    process.env.etherCustodianAbiText,
    provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingLockTx = await ethTokenLocker.depositToEVM(
    transfer.recipient.slice(2).toLowerCase(), 0, { value: transfer.amount }
  )

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      to: pendingLockTx.to,
      nonce: pendingLockTx.nonce,
      data: pendingLockTx.data,
      value: pendingLockTx.value.toString(),
      safeReorgHeight
    },
    lockHashes: [...transfer.lockHashes, pendingLockTx.hash]
  }
}

async function checkLock (transfer) {
  const provider = getEthProvider()

  const lockHash = last(transfer.lockHashes)
  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    console.log(
      'Wrong eth network for checkLock, expected: %s, got: %s',
      process.env.ethChainId, ethChainId
    )
    return transfer
  }
  let lockReceipt = await provider.getTransactionReceipt(lockHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!lockReceipt) {
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data,
        value: transfer.ethCache.value
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      lockReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!lockReceipt) return transfer

  if (!lockReceipt.status) {
    const error = `Transaction failed: ${lockReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      lockReceipts: [...transfer.lockReceipts, lockReceipt]
    }
  }
  if (lockReceipt.transactionHash !== lockHash) {
    // Record the replacement tx lockHash
    transfer = {
      ...transfer,
      lockHashes: [...transfer.lockHashes, lockReceipt.transactionHash]
    }
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: LOCK,
    lockReceipts: [...transfer.lockReceipts, lockReceipt]
  }
}

async function checkSync (transfer) {
  if (!transfer.checkSyncInterval) {
    // checkSync every 20s: reasonable value to show the confirmation counter x/30
    transfer = {
      ...transfer,
      checkSyncInterval: Number(process.env.sendToNearSyncInterval)
    }
  }
  if (transfer.nextCheckSyncTimestamp && new Date() < new Date(transfer.nextCheckSyncTimestamp)) {
    return transfer
  }
  const lockReceipt = last(transfer.lockReceipts)
  const eventEmittedAt = lockReceipt.blockNumber
  const syncedTo = await ethOnNearSyncHeight()
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof
  let newCheckSyncInterval = transfer.checkSyncInterval

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'Deposited',
      lockReceipt.transactionHash,
      process.env.etherCustodianAddress,
      process.env.etherCustodianAbiText,
      getEthProvider()
    )
    const nearAccount = await getNearAccount()
    const proofAlreadyUsed = await nearAccount.viewFunction(
      process.env.auroraEvmAccount,
      'is_used_proof',
      Buffer.from(proof),
      { parse: res => Boolean(res[0]) }
    )
    if (proofAlreadyUsed) {
      // TODO: find the event relayer tx hash
      return {
        ...transfer,
        completedStep: MINT,
        completedConfirmations,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Transfer already finalized.']
        // mintHashes: [...transfer.mintHashes, txHash]
      }
    }
    // Increase the interval for the next findEthProof call.
    newCheckSyncInterval = transfer.checkSyncInterval * 2 > Number(process.env.maxFindEthProofInterval) ? transfer.checkSyncInterval : transfer.checkSyncInterval * 2
  }
  return {
    ...transfer,
    nextCheckSyncTimestamp: new Date(Date.now() + newCheckSyncInterval),
    checkSyncInterval: newCheckSyncInterval,
    completedConfirmations,
    status: status.IN_PROGRESS
  }

  /*
  // TODO: uncomment this when manual transfer finalization becomes available on aurora.dev
  if (completedConfirmations < transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)) {
    // Leave some time for the relayer to finalize
    return {
      ...transfer,
      completedConfirmations,
      status: status.IN_PROGRESS
    }
  }

  return {
    ...transfer,
    completedConfirmations,
    completedStep: SYNC,
    status: status.ACTION_NEEDED,
    proof // used when checkSync() is called by mint()
  }
  */
}
const last = arr => arr[arr.length - 1]

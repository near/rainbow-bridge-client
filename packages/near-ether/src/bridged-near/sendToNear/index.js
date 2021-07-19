import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import { ethers } from 'ethers'
import { track } from '@near-eth/client'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider } from '@near-eth/client/dist/utils'
import { urlParams, ethOnNearSyncHeight, findEthProof } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/near-ether/bridged-near/sendToNear'

const BURN = 'burn-e-near-to-natural-near'
const SYNC = 'sync-e-near-to-natural-near'
const UNLOCK = 'unlock-e-near-to-natural-near'

const steps = [
  BURN,
  SYNC,
  UNLOCK
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
  burnHashes: [],
  burnReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  unlockHashes: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [BURN]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Ethereum`,
      [SYNC]: `Wait for ${transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)} transfer confirmations for security`,
      [UNLOCK]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in NEAR`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Transfering to NEAR'
        case BURN: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)}`
        case SYNC: return 'Depositing in NEAR'
        case UNLOCK: return 'Transfer complete'
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
    case null: return burn(transfer)
    case BURN: return checkSync(transfer)
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
    case BURN: return checkSync(transfer)
    case SYNC: return checkUnlock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a burn tx hash
 * Track a new transfer at the completedStep = BURN so that it can be unlocked
 * @param {*} burnTxHash
 */
export async function recover (burnTxHash) {
  const provider = getEthProvider()

  const receipt = await provider.getTransactionReceipt(burnTxHash)
  const eNEAR = new ethers.Contract(
    process.env.eNEARAddress,
    process.env.eNEARAbiText,
    provider
  )
  const filter = eNEAR.filters.TransferToNearInitiated()
  const events = await eNEAR.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const burnEvent = events.find(event => event.transactionHash === burnTxHash)
  if (!burnEvent) {
    throw new Error('Unable to process burn transaction event.')
  }
  const erc20Address = burnEvent.args.token
  const amount = burnEvent.args.amount.toString()
  const recipient = burnEvent.args.accountId
  const sender = burnEvent.args.sender
  const sourceTokenName = 'NEAR'
  const decimals = 24
  const destinationTokenName = 'NEAR'

  let transfer = {
    ...transferDraft,

    amount,
    completedStep: BURN,
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals,
    status: status.IN_PROGRESS,

    burnReceipts: [receipt]
  }

  // Check transfer status
  transfer = await checkSync(transfer)
  return transfer
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
  const sourceTokenName = 'NEAR'
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = 24
  const destinationTokenName = 'NEAR'
  const decimalAmount = new Decimal(amount).times(10 ** decimals)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: decimalAmount.toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: process.env.eNEARAddress,
    sourceTokenName,
    decimals
  }

  transfer = await burn(transfer)

  track(transfer)
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
  if (ethChainId !== Number(process.env.ethChainId)) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for burn, expected: ${process.env.ethChainId}, got: ${ethChainId}`
    )
  }

  const ethTokenLocker = new ethers.Contract(
    process.env.eNEARAddress,
    process.env.eNEARAbiText,
    provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingBurnTx = await ethTokenLocker.transferToNear(transfer.amount, transfer.recipient)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingBurnTx.from,
      to: pendingBurnTx.to,
      safeReorgHeight,
      data: pendingBurnTx.data,
      nonce: pendingBurnTx.nonce
    },
    burnHashes: [...transfer.burnHashes, pendingBurnTx.hash]
  }
}

async function checkBurn (transfer) {
  const provider = getEthProvider()

  const burnHash = last(transfer.burnHashes)
  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    console.log(
      'Wrong eth network for checkBurn, expected: %s, got: %s',
      process.env.ethChainId, ethChainId
    )
    return transfer
  }
  let burnReceipt = await provider.getTransactionReceipt(burnHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!burnReceipt) {
    try {
      const tx = {
        nonce: transfer.ethCache.nonce,
        from: transfer.ethCache.from,
        to: transfer.ethCache.to,
        data: transfer.ethCache.data
      }
      const foundTx = await findReplacementTx(provider, transfer.ethCache.safeReorgHeight, tx)
      if (!foundTx) return transfer
      burnReceipt = await provider.getTransactionReceipt(foundTx.hash)
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

  if (!burnReceipt) return transfer

  if (!burnReceipt.status) {
    const error = `Transaction failed: ${burnReceipt.transactionHash}`
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, error],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  if (burnReceipt.transactionHash !== burnHash) {
    // Record the replacement tx burnHash
    return {
      ...transfer,
      status: status.IN_PROGRESS,
      completedStep: BURN,
      burnHashes: [...transfer.burnHashes, burnReceipt.transactionHash],
      burnReceipts: [...transfer.burnReceipts, burnReceipt]
    }
  }

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    completedStep: BURN,
    burnReceipts: [...transfer.burnReceipts, burnReceipt]
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
  const burnReceipt = last(transfer.burnReceipts)
  const eventEmittedAt = burnReceipt.blockNumber
  const syncedTo = await ethOnNearSyncHeight()
  const completedConfirmations = Math.max(0, syncedTo - eventEmittedAt)
  let proof

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'TransferToNearInitiated',
      burnReceipt.transactionHash,
      process.env.eNEARAddress,
      process.env.eNEARAbiText,
      getEthProvider()
    )
    const nearAccount = await getNearAccount()
    const proofAlreadyUsed = await nearAccount.viewFunction(
      process.env.nativeNEARLockerAddress,
      'is_used_proof',
      Buffer.from(proof)
    )
    if (proofAlreadyUsed) {
      // TODO: find the event relayer tx hash
      return {
        ...transfer,
        completedStep: UNLOCK,
        completedConfirmations,
        status: status.COMPLETE,
        errors: [...transfer.errors, 'Transfer already finalized.']
        // unlockHashes: [...transfer.unlockHashes, txHash]
      }
    }
  }

  if (completedConfirmations < transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)) {
    // Leave some time for the relayer to finalize
    return {
      ...transfer,
      nextCheckSyncTimestamp: new Date(Date.now() + transfer.checkSyncInterval),
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
}

/**
 * Unlock NEAR tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
 * currently dealt with using URL params.
 * @param {*} transfer
 */
async function unlock (transfer) {
  const nearAccount = await getNearAccount()

  // Check if the transfer is finalized and get the proof if not
  transfer = await checkSync(transfer)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // Set url params before this unlock() returns, otherwise there is a chance that checkUnlock() is called before
  // the wallet redirect and the transfer errors because the status is IN_PROGRESS but the expected
  // url param is not there
  urlParams.set({ unlocking: transfer.id })

  // Calling `nearFungibleTokenFactory.deposit` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `deposit` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkUnlock` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(async () => {
    await nearAccount.functionCall(
      process.env.nativeNEARLockerAddress,
      'finalise_eth_to_near_transfer',
      proof,
      // 200Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('200' + '0'.repeat(12)),
      new BN('100000000000000000000').mul(new BN('600'))
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted unlock transaction
 * checkUnlock is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkUnlock can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkUnlock (transfer) {
  const id = urlParams.get('unlocking')
  // NOTE: when a single tx is executed, transactionHashes is equal to that hash
  const txHash = urlParams.get('transactionHashes')
  const errorCode = urlParams.get('errorCode')
  if (!id && !txHash) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect agains the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    // Set status to FAILED so that it can be retried
    const newError = `A deposit transaction was initiated but could not be verified.
      If no transaction was sent from your account, please retry.`
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [...transfer.errors, newError]
    }
  }
  if (!id) {
    // checkstatus managed to call checkUnlock withing the 100ms before wallet redirect
    // so id is not yet set
    console.log('Waiting for Near wallet redirect to sign unlock')
    return transfer
  }
  if (id !== transfer.id) {
    // Another unlocking transaction cannot be in progress, ie if checkUnlock is called on
    // an in progess unlock then the transfer ids must be equal or the url callback is invalid.
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
    // If checkUnlock is called before unlock sig wallet redirect,
    // log the error but don't mark as FAILED and don't clear url params
    // as the wallet redirect has not happened yet
    const newError = 'Tx hash not received: pending redirect or wallet error'
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
  const unlockTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, nearAccount.accountId
  )

  if (unlockTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (unlockTx.status.Failure) {
    urlParams.clear()
    console.error('unlockTx.status.Failure', unlockTx.status.Failure)
    const errorMessage = typeof unlockTx.status.Failure === 'object'
      ? parseRpcError(unlockTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${unlockTx.transaction.hash}">${unlockTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      unlockHashes: [...transfer.unlockHashes, txHash],
      unlockTx
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    completedStep: UNLOCK,
    status: status.COMPLETE,
    unlockHashes: [...transfer.unlockHashes, txHash]
  }
}

const last = arr => arr[arr.length - 1]

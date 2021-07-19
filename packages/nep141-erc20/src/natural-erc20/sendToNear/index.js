import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import { ethers } from 'ethers'
import { track, get } from '@near-eth/client'
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors'
import { utils } from 'near-api-js'
import { stepsFor } from '@near-eth/client/dist/i18nHelpers'
import * as status from '@near-eth/client/dist/statuses'
import { getEthProvider, getNearAccount, formatLargeNum, getSignerProvider } from '@near-eth/client/dist/utils'
import { urlParams, ethOnNearSyncHeight, findEthProof } from '@near-eth/utils'
import { findReplacementTx, TxValidationError } from 'find-replacement-tx'
import getName from '../getName'
import getAllowance from '../getAllowance'
import { getDecimals } from '../getMetadata'

export const SOURCE_NETWORK = 'ethereum'
export const DESTINATION_NETWORK = 'near'
export const TRANSFER_TYPE = '@near-eth/nep141-erc20/natural-erc20/sendToNear'

const APPROVE = 'approve-natural-erc20-to-nep141'
const LOCK = 'lock-natural-erc20-to-nep141'
const SYNC = 'sync-natural-erc20-to-nep141'
const MINT = 'mint-natural-erc20-to-nep141'

const steps = [
  APPROVE,
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
  approvalHashes: [],
  approvalReceipts: [],
  completedConfirmations: 0,
  lockHashes: [],
  lockReceipts: [],
  neededConfirmations: 20, // hard-coding until connector contract is updated with this information
  mintHashes: []
}

export const i18n = {
  en_US: {
    steps: transfer => stepsFor(transfer, steps, {
      [APPROVE]: `Approve transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} from Ethereum`,
      [LOCK]: `Start transfer of ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.sourceTokenName} to NEAR`,
      [SYNC]: `Wait for ${transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)} transfer confirmations for security`,
      [MINT]: `Deposit ${formatLargeNum(transfer.amount, transfer.decimals)} ${transfer.destinationTokenName} in NEAR`
    }),
    statusMessage: transfer => {
      if (transfer.status === status.FAILED) return 'Failed'
      if (transfer.status === status.ACTION_NEEDED) {
        switch (transfer.completedStep) {
          case APPROVE: return 'Ready to transfer from Ethereum'
          case SYNC: return 'Ready to deposit in NEAR'
          default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
        }
      }
      switch (transfer.completedStep) {
        case null: return 'Approving transfer'
        case APPROVE: return 'Transfering to NEAR'
        case LOCK: return `Confirming transfer ${transfer.completedConfirmations + 1} of ${transfer.neededConfirmations + Number(process.env.nearEventRelayerMargin)}`
        case SYNC: return 'Depositing in NEAR'
        case MINT: return 'Transfer complete'
        default: throw new Error(`Transfer in unexpected state, transfer with ID=${transfer.id} & status=${transfer.status} has completedStep=${transfer.completedStep}`)
      }
    },
    callToAction: transfer => {
      if (transfer.status === status.FAILED) return 'Retry'
      if (transfer.status !== status.ACTION_NEEDED) return null
      switch (transfer.completedStep) {
        case APPROVE: return 'Transfer'
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
    case null: return approve(transfer)
    case APPROVE: return lock(transfer)
    case LOCK: return checkSync(transfer)
    case SYNC: return mint(transfer)
    default: throw new Error(`Don't know how to act on transfer: ${transfer.id}`)
  }
}

/**
 * Called when status is IN_PROGRESS
 * @param {*} transfer
 */
export function checkStatus (transfer) {
  switch (transfer.completedStep) {
    case null: return checkApprove(transfer)
    case APPROVE: return checkLock(transfer)
    case LOCK: return checkSync(transfer)
    case SYNC: return checkMint(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Recover transfer from a lock tx hash
 * Track a new transfer at the completedStep = LOCK so that it can be minted
 * @param {*} lockTxHash
 */
export async function recover (lockTxHash) {
  const provider = getEthProvider()

  const receipt = await provider.getTransactionReceipt(lockTxHash)
  const ethTokenLocker = new ethers.Contract(
    process.env.ethLockerAddress,
    process.env.ethLockerAbiText,
    provider
  )
  const filter = ethTokenLocker.filters.Locked()
  const events = await ethTokenLocker.queryFilter(filter, receipt.blockNumber, receipt.blockNumber)
  const lockedEvent = events.find(event => event.transactionHash === lockTxHash)
  if (!lockedEvent) {
    throw new Error('Unable to process lock transaction event.')
  }
  const erc20Address = lockedEvent.args.token
  const amount = lockedEvent.args.amount.toString()
  const recipient = lockedEvent.args.accountId
  const sender = lockedEvent.args.sender
  const sourceTokenName = await getName(erc20Address)
  const decimals = await getDecimals(erc20Address)
  const destinationTokenName = 'n' + sourceTokenName

  let transfer = {
    ...transferDraft,

    amount,
    completedStep: LOCK,
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals,
    status: status.IN_PROGRESS,

    lockReceipts: [receipt]
  }

  // Check transfer status
  transfer = await checkSync(transfer)
  return transfer
}

// Call contract given by `erc20` contract, requesting permission for contract
// at `process.env.ethLockerAddress` to transfer 'amount' tokens
// on behalf of the default user set up in authEthereum.js.
// Only wait for transaction to have dependable transactionHash created. Avoid
// blocking to wait for transaction to be mined. Status of transactionHash
// being mined is then checked in checkStatus.
export async function initiate ({
  erc20Address,
  amount,
  sender,
  recipient
}) {
  const [conflictingTransfer] = await get({
    filter: ({ sourceToken, completedStep }) =>
      sourceToken === erc20Address &&
      (!completedStep || completedStep === APPROVE)
  })
  if (conflictingTransfer) {
    throw new Error(
      'Another transfer is already in progress, please complete the "Start transfer" step and try again.'
    )
  }

  // TODO: move to core 'decorate'; get both from contracts
  const sourceTokenName = await getName(erc20Address)
  // TODO: call initiate with a formated amount and query decimals when decorate()
  const decimals = await getDecimals(erc20Address)
  const destinationTokenName = 'n' + sourceTokenName
  const decimalAmount = new Decimal(amount).times(10 ** decimals)

  // various attributes stored as arrays, to keep history of retries
  let transfer = {
    ...transferDraft,

    amount: decimalAmount.toFixed(),
    destinationTokenName,
    recipient,
    sender,
    sourceToken: erc20Address,
    sourceTokenName,
    decimals
  }

  const allowance = await getAllowance({
    erc20Address,
    owner: sender,
    spender: process.env.ethLockerAddress
  })
  if (decimalAmount.comparedTo(new Decimal(allowance)) === 1) {
    // amount > allowance
    transfer = await approve(transfer)
  } else {
    transfer = await lock({
      ...transfer,
      completedStep: APPROVE,
      status: status.ACTION_NEEDED
    })
  }

  track(transfer)
}

async function approve (transfer) {
  const provider = getSignerProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    // Webapp should prevent the user from confirming if the wrong network is selected
    throw new Error(
      `Wrong eth network for approve, expected: ${process.env.ethChainId}, got: ${ethChainId}`
    )
  }

  const safeReorgHeight = await provider.getBlockNumber() - 20
  const erc20Contract = new ethers.Contract(
    transfer.sourceToken,
    process.env.ethErc20AbiText,
    provider.getSigner()
  )
  const pendingApprovalTx = await erc20Contract.approve(process.env.ethLockerAddress, transfer.amount)

  return {
    ...transfer,
    ethCache: {
      from: pendingApprovalTx.from,
      to: pendingApprovalTx.to,
      safeReorgHeight,
      data: pendingApprovalTx.data,
      nonce: pendingApprovalTx.nonce
    },
    approvalHashes: [...transfer.approvalHashes, pendingApprovalTx.hash],
    status: status.IN_PROGRESS
  }
}

async function checkApprove (transfer) {
  const provider = getEthProvider()

  const ethChainId = (await provider.getNetwork()).chainId
  if (ethChainId !== Number(process.env.ethChainId)) {
    console.log(
      'Wrong eth network for checkApprove, expected: %s, got: %s',
      process.env.ethChainId, ethChainId
    )
    return transfer
  }

  const approvalHash = last(transfer.approvalHashes)
  let approvalReceipt = await provider.getTransactionReceipt(approvalHash)

  // If no receipt, check that the transaction hasn't been replaced (speedup or canceled)
  if (!approvalReceipt) {
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
      approvalReceipt = await provider.getTransactionReceipt(foundTx.hash)
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
  if (!approvalReceipt) return transfer

  if (!approvalReceipt.status) {
    const error = `Transaction failed: ${approvalReceipt.transactionHash}`
    return {
      ...transfer,
      approvalReceipts: [...transfer.approvalReceipts, approvalReceipt],
      errors: [...transfer.errors, error],
      status: status.FAILED
    }
  }

  if (approvalReceipt.transactionHash !== approvalHash) {
    // Record the replacement tx approvalHash
    return {
      ...transfer,
      status: status.ACTION_NEEDED,
      completedStep: APPROVE,
      approvalHashes: [...transfer.approvalHashes, approvalReceipt.transactionHash],
      approvalReceipts: [...transfer.approvalReceipts, approvalReceipt]
    }
  }

  return {
    ...transfer,
    approvalReceipts: [...transfer.approvalReceipts, approvalReceipt],
    completedStep: APPROVE,
    status: status.ACTION_NEEDED
  }
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
    process.env.ethLockerAddress,
    process.env.ethLockerAbiText,
    provider.getSigner()
  )

  // If this tx is dropped and replaced, lower the search boundary
  // in case there was a reorg.
  const safeReorgHeight = await provider.getBlockNumber() - 20
  const pendingLockTx = await ethTokenLocker.lockToken(transfer.sourceToken, transfer.amount, transfer.recipient)

  return {
    ...transfer,
    status: status.IN_PROGRESS,
    ethCache: {
      from: pendingLockTx.from,
      to: pendingLockTx.to,
      safeReorgHeight,
      data: pendingLockTx.data,
      nonce: pendingLockTx.nonce
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
    return {
      ...transfer,
      status: status.IN_PROGRESS,
      completedStep: LOCK,
      lockHashes: [...transfer.lockHashes, lockReceipt.transactionHash],
      lockReceipts: [...transfer.lockReceipts, lockReceipt]
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

  if (completedConfirmations > transfer.neededConfirmations) {
    // Check if relayer already minted
    proof = await findEthProof(
      'Locked',
      lockReceipt.transactionHash,
      process.env.ethLockerAddress,
      process.env.ethLockerAbiText,
      getEthProvider()
    )
    const nearAccount = await getNearAccount()
    const proofAlreadyUsed = await nearAccount.viewFunction(
      process.env.nearTokenFactoryAccount,
      'is_used_proof',
      Buffer.from(proof)
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
 * Mint NEP141 tokens to transfer.recipient. Causes a redirect to NEAR Wallet,
 * currently dealt with using URL params.
 * @param {*} transfer
 */
async function mint (transfer) {
  const nearAccount = await getNearAccount()

  // Check if the transfer is finalized and get the proof if not
  transfer = await checkSync(transfer)
  if (transfer.status !== status.ACTION_NEEDED) return transfer
  const proof = transfer.proof

  // Set url params before this mint() returns, otherwise there is a chance that checkMint() is called before
  // the wallet redirect and the transfer errors because the status is IN_PROGRESS but the expected
  // url param is not there
  urlParams.set({ minting: transfer.id })

  // Calling `nearFungibleTokenFactory.deposit` causes a redirect to NEAR Wallet.
  //
  // This adds some info about the current transaction to the URL params, then
  // returns to mark the transfer as in-progress, and THEN executes the
  // `deposit` function.
  //
  // Since this happens very quickly in human time, a user will not have time
  // to start two `deposit` calls at the same time, and the `checkMint` will be
  // able to correctly identify the transfer and see if the transaction
  // succeeded.
  setTimeout(async () => {
    await nearAccount.functionCall(
      process.env.nearTokenFactoryAccount,
      'deposit',
      proof,
      // 200Tgas: enough for execution, not too much so that a 2fa tx is within 300Tgas
      new BN('200' + '0'.repeat(12)),
      // We need to attach tokens because minting increases the contract state, by <600 bytes, which
      // requires an additional 0.06 NEAR to be deposited to the account for state staking.
      // Note technically 0.0537 NEAR should be enough, but we round it up to stay on the safe side.
      new BN('100000000000000000000').mul(new BN('600'))
    )
  }, 100)

  return {
    ...transfer,
    status: status.IN_PROGRESS
  }
}

/**
 * Process a broadcasted mint transaction
 * checkMint is called in a loop by checkStatus for in progress transfers
 * urlParams should be cleared only if the transaction succeded or if it FAILED
 * Otherwise if this function throws due to provider or returns, then urlParams
 * should not be cleared so that checkMint can try again at the next loop.
 * So urlparams.clear() is called when status.FAILED or at the end of this function.
 * @param {*} transfer
 */
export async function checkMint (transfer) {
  const id = urlParams.get('minting')
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
    // checkstatus managed to call checkMint withing the 100ms before wallet redirect
    // so id is not yet set
    console.log('Waiting for Near wallet redirect to sign mint')
    return transfer
  }
  if (id !== transfer.id) {
    // Another minting transaction cannot be in progress, ie if checkMint is called on
    // an in progess mint then the transfer ids must be equal or the url callback is invalid.
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
    // If checkMint is called before mint sig wallet redirect,
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
  const mintTx = await nearAccount.connection.provider.txStatus(
    decodedTxHash, nearAccount.accountId
  )

  if (mintTx.status.Unknown) {
    // Transaction or receipt not processed yet
    return transfer
  }

  // Check status of tx broadcasted by wallet
  if (mintTx.status.Failure) {
    urlParams.clear()
    console.error('mintTx.status.Failure', mintTx.status.Failure)
    const errorMessage = typeof mintTx.status.Failure === 'object'
      ? parseRpcError(mintTx.status.Failure)
      : `Transaction <a href="${process.env.nearExplorerUrl}/transactions/${mintTx.transaction.hash}">${mintTx.transaction.hash}</a> failed`

    return {
      ...transfer,
      errors: [...transfer.errors, errorMessage],
      status: status.FAILED,
      mintHashes: [...transfer.mintHashes, txHash],
      mintTx
    }
  }

  // Clear urlParams at the end so that if the provider connection throws,
  // checkStatus will be able to process it again in the next loop.
  urlParams.clear()

  return {
    ...transfer,
    completedStep: MINT,
    status: status.COMPLETE,
    mintHashes: [...transfer.mintHashes, txHash]
  }
}

const last = arr => arr[arr.length - 1]

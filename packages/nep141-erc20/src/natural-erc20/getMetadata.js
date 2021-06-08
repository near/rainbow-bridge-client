import { ethers } from 'ethers'
import getName from './getName'
import { getEthProvider } from '@near-eth/client/dist/utils'

async function getBalance (address, user) {
  if (!user) return null

  const provider = getEthProvider()

  const erc20Contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )

  return (await erc20Contract.balanceOf(user)).toString()
}

const erc20Decimals = {}
export async function getDecimals (address) {
  if (erc20Decimals[address] !== undefined) return erc20Decimals[address]

  const provider = getEthProvider()

  const contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )

  erc20Decimals[address] = Number(await contract.decimals())

  return erc20Decimals[address]
}

const erc20Icons = {}
async function getIcon (address) {
  if (erc20Icons[address] !== undefined) return erc20Icons[address]

  // Checksum address needed to fetch token icons.
  const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${
    ethers.utils.getAddress(address)
  }/logo.png`

  erc20Icons[address] = await new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve(url)
    img.onerror = () => resolve(null)
    img.src = url
  })

  return erc20Icons[address]
}

/**
 * Fetch name, icon, and decimals (precision) of ERC20 token with given `address`.
 *
 * Can provide an Ethereum wallet address as second argument, in which case that
 * wallet's balance will also be returned. If omitted, `balance` is returned as `null`.
 *
 * Values other than `balance` are cached.
 *
 * @param address ERC20 token contract address
 * @param user (optional) Ethereum wallet address that may hold tokens with given `address`
 *
 * @returns {Promise<{ address: string, balance: number|null, decimals: number, icon: string|null, name: string }>}
 */
export default async function getErc20Data (address, user) {
  const [balance, decimals, icon, name] = await Promise.all([
    getBalance(address, user),
    getDecimals(address),
    getIcon(address),
    getName(address)
  ])
  return {
    address,
    balance,
    decimals,
    icon,
    name
  }
}

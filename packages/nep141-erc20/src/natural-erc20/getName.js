import { ethers } from 'ethers'
import { getEthProvider } from '@near-eth/client/dist/utils'

const erc20Names = {}
export default async function getName (address) {
  if (erc20Names[address]) return erc20Names[address]

  const provider = getEthProvider()

  const contract = new ethers.Contract(
    address,
    process.env.ethErc20AbiText,
    provider
  )
  try {
    erc20Names[address] = await contract.symbol()
  } catch {
    console.log(`Failed to read token symbol for: ${address}`)
    erc20Names[address] = address.slice(0, 5) + '…'
  }
  
  return erc20Names[address]
}

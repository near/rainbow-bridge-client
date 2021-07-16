import Web3 from 'web3'
import { getEthProvider } from '@near-eth/client/dist/utils'

export default async function getBalance (address, user) {
  if (!user) return null

  const web3 = new Web3(getEthProvider())

  const erc20Contract = new web3.eth.Contract(
    JSON.parse(process.env.ethErc20AbiText),
    address
  )

  return await erc20Contract.methods.balanceOf(user).call()
}

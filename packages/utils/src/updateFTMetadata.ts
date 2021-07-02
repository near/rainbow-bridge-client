import BN from 'bn.js'
import Web3 from 'web3'
import { utils } from 'near-api-js'
import { getMetadata } from '@near-eth/nep141-erc20/dist/natural-erc20'
import { getNep141Address } from '@near-eth/nep141-erc20/dist/bridged-nep141'
import { getNearAccount, getAuroraProvider } from '@near-eth/client/dist/utils'


export default async function updateFungibleTokenMetadata (address: any) {
    // Read metadata from Eth ERC-20
    const [decimals, icon, name, symbol ] = await getMetadata(address)
    // Push metadata to the NEP-141
    const nep141Address = getNep141Address(address)
    const nearAccount = await getNearAccount()
    await nearAccount.functionCall(
        nep141Address,
        'set_metadata',
        { 
            name: name, 
            symbol: symbol, 
            reference:'', // leave it empty for now
            reference_hash: '', // leave it empty for now
            decimals: decimals 
        },
        new BN(3e13).mul(new BN(2)),
        new BN(utils.format.parseNearAmount('3.02')
    ))
    // Push metadata to Aurora ERC-20
    const web3 = new Web3(getAuroraProvider())
    const contract = new web3.eth.Contract(
        JSON.parse(process.env.ethErc20AbiText),
        address
    )
    
    //TODO: needs to update the key and send the tx from the admin account
    //TODO: add check to make sure that the contract has been updated
    await contract.methods.adminSstore(0x0, name).send();
    await contract.methods.adminSstore(0x0, symbol).send();
    await contract.methods.adminSstore(0x0, decimals).send();
}

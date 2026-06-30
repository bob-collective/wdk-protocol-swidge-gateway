// Route: BTC → USDT on Tron. Same as the Base onramp but targets the Tron network.
'use strict'
import { GatewaySwidge } from '../index.js'

export async function run ({ account, http }) {
  const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', http })
  return sw.swidge({
    fromToken: 'BTC',
    toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
    toChain: 'tron',
    recipient: 'TRecipientAddress',
    fromTokenAmount: 100000n
  })
}

// Demonstrates quoting a swidge and checking order status without executing a transaction.
'use strict'
import { GatewaySwidge } from '../index.js'

export async function run ({ account, http }) {
  const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', http })
  const quote = await sw.quoteSwidge({
    fromToken: 'BTC',
    toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
    toChain: 'base',
    recipient: '0xRecipient',
    fromTokenAmount: 100000n
  })
  const status = await sw.getSwidgeStatus('order-id')
  return { quote, status }
}

// Route: USDT on Base → BTC. Sends USDT from an EVM account and receives BTC at a Bitcoin address.
import { GatewaySwidge } from '../src/index.js'
import type { HttpTransport } from '../src/http.js'

export async function run({ account, http }: { account?: unknown; http?: HttpTransport }) {
  const sw = new GatewaySwidge(account, { fromChain: 'base', http })
  return sw.swidge({
    fromToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
    toToken: 'BTC',
    toChain: 'bitcoin',
    recipient: 'bc1qRecipientAddress',
    fromTokenAmount: 1000000n,
  })
}

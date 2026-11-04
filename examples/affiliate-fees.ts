// Route: BTC → USDT on Base with a partner affiliate fee of 30 bps.
import { GatewaySwidge } from '../src/index.js'
import type { HttpTransport } from '../src/http.js'

export async function run({ account, http }: { account?: unknown; http?: HttpTransport }) {
  const sw = new GatewaySwidge(account, {
    fromChain: 'bitcoin',
    http,
    affiliates: [{ address: '0xPartnerAddress', bps: 30 }],
  })
  return sw.swidge({
    fromToken: 'BTC',
    toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
    toChain: 'base',
    recipient: '0xRecipient',
    fromTokenAmount: 100000n,
  })
}

// Route: USDC → USDT on Base (same-chain EVM swap via the inherited swap() method).
import { GatewaySwidge } from '../src/index.js'
import type { HttpTransport } from '../src/http.js'

export async function run({ account, http }: { account?: unknown; http?: HttpTransport }) {
  const sw = new GatewaySwidge(account, { fromChain: 'base', http })
  return sw.swap({
    tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    tokenOut: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
    tokenInAmount: 1000000n,
  })
}

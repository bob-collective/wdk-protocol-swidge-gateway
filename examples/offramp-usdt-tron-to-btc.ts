// Route: USDT on Tron → BTC. Sends TRC-20 USDT from a WDK Tron account and receives BTC.
//
// Tron needs one extra step versus the EVM offramp: WalletAccountTron has no `approve`
// method (its `transfer` is a fixed `transfer(address,uint256)`), so the TRC-20 allowance
// is granted through the arbitrary contract-call path via `buildTronApproval`.
import { GatewaySwidge, buildTronApproval } from '../src/index.js'
import type { HttpTransport } from '../src/http.js'

interface TronAccount {
  sendTransaction(tx: unknown): Promise<{ hash: string }>
}

export async function run({ account, http }: { account?: unknown; http?: HttpTransport }) {
  const sw = new GatewaySwidge(account, { fromChain: 'tron', http })
  const route = {
    fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
    toToken: 'BTC',
    toChain: 'bitcoin',
    recipient: 'bc1qRecipientAddress',
    fromTokenAmount: 1000000n,
  }

  const approval = await sw.getRequiredApproval(route)
  if (approval) {
    await (account as TronAccount).sendTransaction(buildTronApproval(approval))
  }

  return sw.swidge(route)
}

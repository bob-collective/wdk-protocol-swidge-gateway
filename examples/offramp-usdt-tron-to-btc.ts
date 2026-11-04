// Route: USDT on Tron → BTC. WalletAccountTron has no `approve` method, so the TRC-20
// allowance goes out through the arbitrary contract-call path via `buildTronApproval`.
import { GatewaySwidge, buildTronApproval } from '../src/index.js'
import type { HttpTransport } from '../src/http.js'

interface TronAccount {
  sendTransaction(tx: unknown): Promise<{ hash: string }>
}

const POLL_INTERVAL_MS = 3_000
const MAX_POLLS = 20

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

    let allowanceConfirmed = false
    for (let i = 0; i < MAX_POLLS; i++) {
      if ((await sw.getRequiredApproval(route)) === null) {
        allowanceConfirmed = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    if (!allowanceConfirmed) {
      throw new Error('TRC-20 approval was not mined in time — aborting before the swap')
    }
  }

  return sw.swidge(route)
}

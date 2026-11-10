import type { GatewayOrderInfoV3, GatewayTokenTransferV3 } from '../types.js'
import type { SwidgeStatusResult, SwidgeTransaction } from '@tetherto/wdk-wallet/protocols'

function transfers(
  list: GatewayTokenTransferV3[] | undefined,
  type: 'destination' | 'refund'
): SwidgeTransaction[] {
  return (list ?? [])
    .filter((t) => typeof t.txHash === 'string' && t.txHash !== '')
    .map((t) => ({ hash: t.txHash, chain: t.chain, type }))
}

/**
 * Map a `GatewayOrderInfoV3` to a `SwidgeStatusResult`.
 *
 * `transactions` carries every hash the order exposes: the source tx (`srcInfo.txHash`, or a
 * legacy `pending_btc_payment`), the destination payouts (`received_tokens[].txHash`) and the
 * refunds (`refunded_tokens[].txHash`).
 */
export function toSwidgeStatus(order: GatewayOrderInfoV3): SwidgeStatusResult {
  const s = order.status || {}
  const transactions: SwidgeTransaction[] = []

  const src = order.srcInfo
  const pending = s.inProgress?.pending_btc_payment
  if (src?.txHash) transactions.push({ hash: src.txHash, chain: src.chain, type: 'source' })
  else if (pending?.txid)
    transactions.push({ hash: pending.txid, chain: 'bitcoin', type: 'source' })

  transactions.push(...transfers(s.success?.received_tokens, 'destination'))
  transactions.push(...transfers(s.refunded?.refunded_tokens, 'refund'))

  if (s.success) return { status: 'completed', transactions }
  if (s.refunded) return { status: 'refunded', transactions }
  if (s.failed) return { status: s.failed.refund_tx ? 'refund-pending' : 'failed', transactions }
  if (s.inProgress?.refund_tx) return { status: 'refund-pending', transactions }
  return { status: 'pending', transactions }
}

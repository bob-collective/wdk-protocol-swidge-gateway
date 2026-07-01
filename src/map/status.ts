import type { GatewayOrderInfoV3 } from '../types.js'
import type { SwidgeStatusResult } from '@tetherto/wdk-wallet/protocols'

/**
 * Map a GatewayOrderInfoV3 to a SwidgeStatusResult.
 */
export function toSwidgeStatus(order: GatewayOrderInfoV3): SwidgeStatusResult {
  const s = order.status || {}
  if (s.Success) return { status: 'completed', transactions: [] }
  if (s.Refunded) return { status: 'refunded', transactions: [] }
  if (s.Failed) return { status: s.Failed.refund_tx ? 'refund-pending' : 'failed', transactions: [] }
  if (s.InProgress) {
    if (s.InProgress.refund_tx) return { status: 'refund-pending', transactions: [] }
    const pending = s.InProgress.pending_btc_payment
    const transactions = pending ? [{ hash: pending.txid, type: 'source' as const }] : []
    return { status: 'pending', transactions }
  }
  return { status: 'pending', transactions: [] }
}

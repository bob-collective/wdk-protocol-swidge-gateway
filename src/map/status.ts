import type { GatewayOrderInfoV3 } from '../types.js'
import type { SwidgeStatusResult } from '@tetherto/wdk-wallet/protocols'

/**
 * Map a GatewayOrderInfoV3 to a SwidgeStatusResult.
 */
export function toSwidgeStatus(order: GatewayOrderInfoV3): SwidgeStatusResult {
  const s = order.status || {}
  if (s.success) return { status: 'completed', transactions: [] }
  if (s.refunded) return { status: 'refunded', transactions: [] }
  if (s.failed) return { status: s.failed.refund_tx ? 'refund-pending' : 'failed', transactions: [] }
  if (s.inProgress) {
    if (s.inProgress.refund_tx) return { status: 'refund-pending', transactions: [] }
    const pending = s.inProgress.pending_btc_payment
    const transactions = pending ? [{ hash: pending.txid, type: 'source' as const }] : []
    return { status: 'pending', transactions }
  }
  return { status: 'pending', transactions: [] }
}

'use strict'

/** @param {import('../types.js').GatewayOrderInfoV3} order @returns {{ status: string, transactions: object[] }} */
export function toSwidgeStatus (order) {
  const s = order.status || {}
  if (s.Success) return { status: 'completed', transactions: [] }
  if (s.Refunded) return { status: 'refunded', transactions: [] }
  if (s.Failed) return { status: s.Failed.refund_tx ? 'refund-pending' : 'failed', transactions: [] }
  if (s.InProgress) {
    if (s.InProgress.refund_tx) return { status: 'refund-pending', transactions: [] }
    const pending = s.InProgress.pending_btc_payment
    const transactions = pending ? [{ hash: pending.txid, type: 'source' }] : []
    return { status: 'pending', transactions }
  }
  return { status: 'pending', transactions: [] }
}

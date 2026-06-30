'use strict'

import { GatewaySwidgeError, ERR } from '../errors.js'

/**
 * Extract a normalised payload from a GatewayCreateOrderV3 response.
 *
 * The wire response is an externally-tagged union: `{ onramp: {...} }` |
 * `{ offramp: {...} }` | `{ tokenSwap: {...} }`.
 *
 * Note: the onramp create-order response carries no amount field, so the BTC
 * send amount is sourced from the quote (`quote.onramp.inputAmount.amount`).
 *
 * @param {object} order   Raw GatewayCreateOrderV3 response object.
 * @param {'onramp'|'offramp'|'tokenSwap'} variant
 * @param {object} [quote] GatewayQuoteV3 response (required when variant === 'onramp').
 * @returns {{ orderId: string, kind: 'btc'|'evm', address?: string, amount?: bigint, tx?: { to: string, data: string, value: string } }}
 */
export function orderPayload (order, variant, quote) {
  const o = order[variant]
  if (!o || !o.orderId) {
    throw new GatewaySwidgeError(ERR.HTTP, `create-order missing ${variant}.orderId`, { cause: order })
  }
  if (variant === 'onramp') {
    return {
      orderId: o.orderId,
      kind: 'btc',
      address: o.address,
      amount: BigInt(quote.onramp.inputAmount.amount)
    }
  }
  return {
    orderId: o.orderId,
    kind: 'evm',
    tx: { to: o.tx.to, data: o.tx.data, value: o.tx.value }
  }
}

import { GatewaySwidgeError, ERR } from '../errors.js'
import type { SwidgeVariant } from '../chains.js'

export type OrderKind = 'btc' | 'evm'

export interface BtcOrderPayload {
  orderId: string
  kind: 'btc'
  address: string
  amount: bigint
}

export interface EvmOrderPayload {
  orderId: string
  kind: 'evm'
  tx: { to: string; data: string; value: string }
}

export type OrderPayload = BtcOrderPayload | EvmOrderPayload

interface OnrampOrder {
  orderId: string
  address: string
}

interface EvmOrder {
  orderId: string
  tx: { to: string; data: string; value: string }
}

interface RawOrder {
  onramp?: OnrampOrder
  offramp?: EvmOrder
  tokenSwap?: EvmOrder
  [key: string]: unknown
}

interface OnrampQuote {
  inputAmount: { amount: string }
}

interface RawQuote {
  onramp?: OnrampQuote
  [key: string]: unknown
}

/**
 * Extract a normalised payload from a GatewayCreateOrderV3 response.
 *
 * The wire response is an externally-tagged union: `{ onramp: {...} }` |
 * `{ offramp: {...} }` | `{ tokenSwap: {...} }`.
 *
 * Note: the onramp create-order response carries no amount field, so the BTC
 * send amount is sourced from the quote (`quote.onramp.inputAmount.amount`).
 */
export function orderPayload(order: RawOrder, variant: SwidgeVariant, quote?: RawQuote): OrderPayload {
  const o = order[variant] as (OnrampOrder & EvmOrder) | undefined
  if (!o || !o.orderId) {
    throw new GatewaySwidgeError(ERR.HTTP, `create-order missing ${variant}.orderId`, {
      cause: order,
    })
  }
  if (variant === 'onramp') {
    return {
      orderId: o.orderId,
      kind: 'btc',
      address: o.address,
      amount: BigInt(quote!.onramp!.inputAmount.amount),
    }
  }
  return {
    orderId: o.orderId,
    kind: 'evm',
    tx: { to: o.tx.to, data: o.tx.data, value: o.tx.value },
  }
}

import { GatewaySwidgeError, ERR } from '../errors.js'
import type { SwidgeVariant } from '../chains.js'

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

export interface TronOrderPayload {
  orderId: string
  kind: 'tron'
  tx: { to: string; data: string; value: string; feeLimit?: string }
}

export type OrderPayload = BtcOrderPayload | EvmOrderPayload | TronOrderPayload

interface OnrampOrder {
  order_id: string
  address: string
}

interface CallOrder {
  order_id: string
  tx: { type?: string; to: string; data: string; value: string; feeLimit?: string }
}

interface RawOrder {
  onramp?: OnrampOrder
  offramp?: CallOrder
  tokenSwap?: CallOrder
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
 * The `tx` of an offramp/tokenSwap order is itself an internally-tagged union
 * (`GatewayTxData`) discriminated by `tx.type` — `evm` | `tron` | `solana`. The
 * tag is absent on older EVM responses, so a missing `type` means EVM.
 *
 * Note: the onramp create-order response carries no amount field, so the BTC
 * send amount is sourced from the quote (`quote.onramp.inputAmount.amount`).
 */
export function orderPayload(
  order: RawOrder,
  variant: SwidgeVariant,
  quote?: RawQuote
): OrderPayload {
  const o = order[variant] as (OnrampOrder & CallOrder) | undefined
  if (!o || !o.order_id) {
    throw new GatewaySwidgeError(ERR.HTTP, `create-order missing ${variant}.orderId`, {
      cause: order,
    })
  }
  if (variant === 'onramp') {
    return {
      orderId: o.order_id,
      kind: 'btc',
      address: o.address,
      amount: BigInt(quote!.onramp!.inputAmount.amount),
    }
  }
  const tx = o.tx
  if (!tx) {
    throw new GatewaySwidgeError(ERR.HTTP, `create-order missing ${variant}.tx`, { cause: order })
  }
  if (tx.type === 'tron') {
    return {
      orderId: o.order_id,
      kind: 'tron',
      tx: { to: tx.to, data: tx.data, value: tx.value, feeLimit: tx.feeLimit },
    }
  }
  if (tx.type != null && tx.type !== 'evm') {
    throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, `order tx type '${tx.type}' is not supported`, {
      cause: order,
    })
  }
  return { orderId: o.order_id, kind: 'evm', tx: { to: tx.to, data: tx.data, value: tx.value } }
}

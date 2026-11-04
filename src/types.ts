// V4 request/response shapes used by this module. Mirrors bob-gateway crates/gateway-api models.
// V4 keeps the V3 order models (`GatewayCreateOrderV3`, `GatewayOrderInfoV3`), hence their names.
// (Hand-written: the OpenAPI components(schemas()) are not reliably emitted — see spec §10.6.)

import type { BtcSimulateResult } from './chain-adapters/bitcoin.js'
import type { EvmRequiredApproval, EvmSimulateResult } from './chain-adapters/evm.js'
import type { TronSimulateResult } from './chain-adapters/tron.js'

export type { BtcSimulateResult, EvmRequiredApproval, EvmSimulateResult, TronSimulateResult }

/**
 * Result of `GatewaySwidge.simulateSwidge()`.
 *
 * `broadcast` is always `false` — no transaction was sent, no registerTx called.
 * An orphaned Gateway order is created as a side-effect (the gateway reconciles these).
 */
export type SwidgeSimulation = {
  variant: 'onramp' | 'offramp' | 'tokenSwap'
  orderId: string
  /** Mapped quote (same shape as `quoteSwidge` output). */
  quote: Record<string, unknown>
  broadcast: false
} & ({ onramp: BtcSimulateResult } | { evm: EvmSimulateResult } | { tron: TronSimulateResult })

export interface GetQuoteParamsV4 {
  srcChain: string
  dstChain: string
  srcToken: string
  dstToken: string
  amount: string
  /** Basis points. Optional in V4: omitted, the gateway picks one per route and echoes it. */
  slippage?: string
  sender?: string
  recipient: string
  /** Source-chain encoded. Optional for a price-only quote; create-order rejects a quote without it. */
  refundAddress?: string
  affiliates?: string
}

/** V4 register-tx body: onramp only, signed raw Bitcoin tx hex only (the gateway broadcasts it). */
export interface RegisterTxV4 {
  onramp: { order_id: string; bitcoin_tx_hex: string }
}

// Discriminated by the present key
export interface GatewayOrderStatusV3 {
  inProgress?: {
    refund_tx?: object | null
    pending_btc_payment?: { txid: string; amount: string } | null
  }
  failed?: { refund_tx?: object | null }
  success?: { received_tokens: object[] }
  refunded?: { refunded_tokens: object[] }
}

export interface GatewayOrderInfoV3 {
  id: string
  timestamp: number
  status: GatewayOrderStatusV3
  estimated_time_in_secs?: number
  deposit_address?: string | null
}

// V4 request/response shapes used by this module. Mirrors bob-gateway crates/gateway-api models.
// V4 keeps the V3 order models (`GatewayCreateOrderV3`, `GatewayOrderInfoV3`), hence their names.
// (Hand-written: the OpenAPI components(schemas()) are not reliably emitted — see spec §10.6.)

import type { BtcSimulateResult } from './chain-adapters/bitcoin.js'
import type { EvmRequiredApproval, EvmSimulateResult } from './chain-adapters/evm.js'
import type { TronSimulateResult } from './chain-adapters/tron.js'

export type { BtcSimulateResult, EvmRequiredApproval, EvmSimulateResult, TronSimulateResult }

/** Result of `GatewaySwidge.simulateSwidge()`, keyed by the source chain's dry run. */
export type SwidgeSimulation = {
  /** The route: `onramp` (BTC → token), `offramp` (token → BTC) or `tokenSwap`. */
  variant: 'onramp' | 'offramp' | 'tokenSwap'
  /** The id of the gateway order created for the dry run; it is never funded. */
  orderId: string
  /** The quote, as `quoteSwidge()` returns it. */
  quote: Record<string, unknown>
  /** Always `false`: nothing was broadcast or registered. */
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

/**
 * `GatewayUserTokenTransferV3`. A standalone camelCase struct, so `txHash` is camelCase even though
 * the status-variant fields that hold it (`received_tokens`, `refunded_tokens`) are snake_case.
 */
export interface GatewayTokenTransferV3 {
  token: string
  amount: string
  chain: string
  txHash: string
  usd?: string | null
}

// Discriminated by the present key. Variant keys camelCase, fields inside snake_case (see AGENTS.md).
export interface GatewayOrderStatusV3 {
  inProgress?: {
    refund_tx?: object | null
    /** No longer populated by the gateway; kept for older orders. */
    pending_btc_payment?: { txid: string; amount: string } | null
  }
  failed?: { refund_tx?: object | null }
  success?: { received_tokens: GatewayTokenTransferV3[] }
  refunded?: { refunded_tokens: GatewayTokenTransferV3[] }
}

/** `ChainTxInfoV3`: the order's source leg. `txHash` is null until the source tx is indexed. */
export interface GatewayChainTxInfoV3 {
  chain: string
  token: string
  amount: string
  txHash?: string | null
  usd?: string | null
}

/** get-order response. Top-level struct fields are camelCase. */
export interface GatewayOrderInfoV3 {
  id: string
  timestamp: number
  srcInfo?: GatewayChainTxInfoV3
  dstInfo?: { chain: string; token: string; amount: string; usd?: string | null }
  status: GatewayOrderStatusV3
  estimatedTimeInSecs?: number | null
  depositAddress?: string | null
}

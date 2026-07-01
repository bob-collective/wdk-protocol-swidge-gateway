// V3 request/response shapes used by this module. Mirrors bob-gateway crates/gateway-api models.
// (Hand-written: the V3 OpenAPI components(schemas()) are not reliably emitted — see spec §10.6.)

import type { BtcSimulateResult } from './chain-adapters/bitcoin.js'
import type { EvmSimulateResult } from './chain-adapters/evm.js'

export type { BtcSimulateResult, EvmSimulateResult }

/**
 * Result of `GatewaySwidge.simulateSwidge()`.
 *
 * `broadcast` is always `false` — no transaction was sent, no registerTx called.
 * An orphaned Gateway order is created as a side-effect (the gateway reconciles these).
 */
export type SwidgeSimulation =
  | {
      variant: 'onramp' | 'offramp' | 'tokenSwap'
      orderId: string
      /** Mapped quote (same shape as `quoteSwidge` output). */
      quote: Record<string, unknown>
      broadcast: false
      onramp: BtcSimulateResult
    }
  | {
      variant: 'onramp' | 'offramp' | 'tokenSwap'
      orderId: string
      /** Mapped quote (same shape as `quoteSwidge` output). */
      quote: Record<string, unknown>
      broadcast: false
      evm: EvmSimulateResult
    }

export interface GetQuoteParamsV3 {
  srcChain: string
  dstChain: string
  srcToken: string
  dstToken: string
  amount: string
  slippage: string
  sender?: string
  recipient: string
  ownerAddress?: string
  refundAddress?: string
  affiliates?: string
  gasRefill?: string
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

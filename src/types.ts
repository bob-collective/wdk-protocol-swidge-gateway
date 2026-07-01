// V3 request/response shapes used by this module. Mirrors bob-gateway crates/gateway-api models.
// (Hand-written: the V3 OpenAPI components(schemas()) are not reliably emitted — see spec §10.6.)

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
  InProgress?: {
    refund_tx?: object | null
    pending_btc_payment?: { txid: string; amount: string } | null
  }
  Failed?: { refund_tx?: object | null }
  Success?: { received_tokens: object[] }
  Refunded?: { refunded_tokens: object[] }
}

export interface GatewayOrderInfoV3 {
  id: string
  timestamp: number
  status: GatewayOrderStatusV3
  estimated_time_in_secs?: number
  deposit_address?: string | null
}

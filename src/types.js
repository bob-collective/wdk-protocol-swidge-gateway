'use strict'
// V3 request/response shapes used by this module. Mirrors bob-gateway crates/gateway-api models.
// (Hand-written: the V3 OpenAPI components(schemas()) are not reliably emitted — see spec §10.6.)

/** @typedef {Object} GetQuoteParamsV3
 * @property {string} srcChain @property {string} dstChain @property {string} srcToken @property {string} dstToken
 * @property {string} amount @property {string} slippage @property {string} [sender] @property {string} recipient
 * @property {string} [ownerAddress] @property {string} [refundAddress] @property {string} [affiliates] @property {string} [gasRefill] */

/** @typedef {Object} GatewayOrderStatusV3  // discriminated by the present key
 * @property {{ refund_tx?: object|null, pending_btc_payment?: { txid: string, amount: string }|null }} [InProgress]
 * @property {{ refund_tx?: object|null }} [Failed]
 * @property {{ received_tokens: object[] }} [Success]
 * @property {{ refunded_tokens: object[] }} [Refunded] */

/** @typedef {Object} GatewayOrderInfoV3
 * @property {string} id @property {number} timestamp @property {GatewayOrderStatusV3} status
 * @property {number} [estimated_time_in_secs] @property {string|null} [deposit_address] */

export {}

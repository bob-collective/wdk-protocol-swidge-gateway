'use strict'
import { GatewaySwidgeError, ERR } from '../errors.js'

const MAX_AFFILIATES = 5
const MAX_TOTAL_BPS = 1000

/** @param {{address:string,bps:number}[]} affiliates @returns {string} */
export function serializeAffiliates (affiliates) {
  if (!affiliates || affiliates.length === 0) return ''
  if (affiliates.length > MAX_AFFILIATES) throw new GatewaySwidgeError(ERR.VALIDATION, `at most ${MAX_AFFILIATES} affiliates`)
  const seen = new Set()
  let total = 0
  for (const a of affiliates) {
    if (!a.address) throw new GatewaySwidgeError(ERR.VALIDATION, 'affiliate address required')
    if (seen.has(a.address.toLowerCase())) throw new GatewaySwidgeError(ERR.VALIDATION, `duplicate affiliate ${a.address}`)
    seen.add(a.address.toLowerCase())
    if (!(a.bps > 0)) throw new GatewaySwidgeError(ERR.VALIDATION, 'affiliate bps must be greater than zero')
    total += a.bps
    if (total > MAX_TOTAL_BPS) throw new GatewaySwidgeError(ERR.VALIDATION, `total affiliate bps exceeds ${MAX_TOTAL_BPS}`)
  }
  return affiliates.map(a => `${a.address}:${a.bps}`).join(',')
}

/**
 * @param {object} options SwidgeOptions (+ fromChain resolved by caller)
 * @param {{ fromAddress?: string, ownerAddress?: string, defaultSlippage: number, affiliates?: {address:string,bps:number}[], variant: string }} ctx
 * @returns {object}
 */
export function toQuoteParams (options, ctx) {
  const slippage = options.slippage ?? ctx.defaultSlippage
  const params = {
    srcChain: options.fromChain,
    dstChain: options.toChain ?? options.fromChain,
    srcToken: options.fromToken,
    dstToken: options.toToken,
    amount: String(options.fromTokenAmount),
    slippage: String(Math.round(slippage * 10000)),
    recipient: options.recipient,
    sender: ctx.fromAddress,
    ownerAddress: ctx.ownerAddress,
    refundAddress: options.refundAddress
  }
  if (ctx.variant !== 'tokenSwap' && ctx.affiliates && ctx.affiliates.length) {
    const s = serializeAffiliates(ctx.affiliates)
    if (s) params.affiliates = s
  }
  return params
}

import { GatewaySwidgeError, ERR } from '../errors.js'

const MAX_AFFILIATES = 5
const MAX_TOTAL_BPS = 1000

export interface Affiliate {
  address: string
  bps: number
}

export function serializeAffiliates(affiliates: Affiliate[]): string {
  if (!affiliates || affiliates.length === 0) return ''
  if (affiliates.length > MAX_AFFILIATES)
    throw new GatewaySwidgeError(ERR.VALIDATION, `at most ${MAX_AFFILIATES} affiliates`)
  const seen = new Set<string>()
  let total = 0
  for (const a of affiliates) {
    if (!a.address) throw new GatewaySwidgeError(ERR.VALIDATION, 'affiliate address required')
    if (seen.has(a.address.toLowerCase()))
      throw new GatewaySwidgeError(ERR.VALIDATION, `duplicate affiliate ${a.address}`)
    seen.add(a.address.toLowerCase())
    if (!(a.bps > 0)) throw new GatewaySwidgeError(ERR.VALIDATION, 'affiliate bps must be greater than zero')
    total += a.bps
    if (total > MAX_TOTAL_BPS)
      throw new GatewaySwidgeError(ERR.VALIDATION, `total affiliate bps exceeds ${MAX_TOTAL_BPS}`)
  }
  return affiliates.map((a) => `${a.address}:${a.bps}`).join(',')
}

export interface QuoteParamsOptions {
  fromChain: string
  toChain?: string
  fromToken: string
  toToken: string
  fromTokenAmount: bigint | number | string
  slippage?: number
  recipient?: string
  refundAddress?: string
  [key: string]: unknown
}

export interface QuoteParamsContext {
  fromAddress?: string
  ownerAddress?: string
  defaultSlippage: number
  affiliates?: Affiliate[]
  variant: string
}

export function toQuoteParams(
  options: QuoteParamsOptions,
  ctx: QuoteParamsContext
): Record<string, string | undefined> {
  const slippage = options.slippage ?? ctx.defaultSlippage
  const params: Record<string, string | undefined> = {
    srcChain: options.fromChain,
    dstChain: options.toChain ?? options.fromChain,
    srcToken: options.fromToken,
    dstToken: options.toToken,
    amount: String(options.fromTokenAmount),
    slippage: String(Math.round(slippage * 10000)),
    recipient: options.recipient,
    sender: ctx.fromAddress,
    ownerAddress: ctx.ownerAddress,
    refundAddress: options.refundAddress,
  }
  if (ctx.variant !== 'tokenSwap' && ctx.affiliates && ctx.affiliates.length) {
    const s = serializeAffiliates(ctx.affiliates)
    if (s) params.affiliates = s
  }
  return params
}

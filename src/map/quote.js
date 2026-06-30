'use strict'

/**
 * Pick the inner quote object from the GatewayQuoteV3 discriminated union.
 * @param {object} gw
 * @returns {object}
 */
function inner (gw) {
  return gw.onramp || gw.offramp || gw.tokenSwap || gw
}

/**
 * Sum two optional string amounts as BigInt, returning 0n if both are absent.
 * @param {string|undefined} a
 * @param {string|undefined} b
 * @returns {bigint}
 */
function sumAmounts (a, b) {
  return (a != null ? BigInt(a) : 0n) + (b != null ? BigInt(b) : 0n)
}

/**
 * Map a GatewayQuoteV3 wire object to a SwidgeQuote.
 *
 * Variant shapes (all camelCase on the wire):
 *  - onramp  (GatewayOnrampQuoteV2): feeBreakdown.{solverFee, protocolFee, affiliateFee, executionFee, layerzeroFee}
 *  - offramp (GatewayOfframpQuoteV3): feeBreakdown.{solverFee, inclusionFee, protocolFee, affiliateFee, fastestFeeRate}
 *  - tokenSwap (GatewayTokenSwapQuoteV2): top-level fees (always zero placeholder), no feeBreakdown
 *
 * Fee mapping:
 *  - network  ← solverFee.amount + inclusionFee.amount (either may be absent)
 *  - protocol ← protocolFee.amount
 *  - affiliate ← affiliateFee.amount
 *  Only included when the computed amount > 0.
 *
 * @param {object} gatewayQuote  Raw GatewayQuoteV3 wire object
 * @param {{ affiliateApplied: boolean }} ctx
 * @returns {{ fromTokenAmount: bigint, toTokenAmount: bigint, toTokenAmountMin: bigint,
 *             fees: Array<{ type: string, amount: bigint }>,
 *             estimatedDuration: number|undefined, expiry: unknown,
 *             priceImpact: string|undefined, affiliateApplied: boolean }}
 */
export function toSwidgeQuote (gatewayQuote, ctx) {
  const q = inner(gatewayQuote)
  const fb = q.feeBreakdown || {}

  const fees = []

  const networkAmount = sumAmounts(
    fb.solverFee?.amount,
    fb.inclusionFee?.amount
  )
  if (networkAmount > 0n) {
    fees.push({ type: 'network', amount: networkAmount })
  }

  const protocolAmount = fb.protocolFee?.amount != null ? BigInt(fb.protocolFee.amount) : 0n
  if (protocolAmount > 0n) {
    fees.push({ type: 'protocol', amount: protocolAmount })
  }

  const affiliateAmount = fb.affiliateFee?.amount != null ? BigInt(fb.affiliateFee.amount) : 0n
  if (affiliateAmount > 0n) {
    fees.push({ type: 'affiliate', amount: affiliateAmount })
  }

  const outputAmountStr = (q.outputAmountMin || q.outputAmount).amount

  return {
    fromTokenAmount: BigInt(q.inputAmount.amount),
    toTokenAmount: BigInt(q.outputAmount.amount),
    toTokenAmountMin: BigInt(outputAmountStr),
    fees,
    estimatedDuration: q.estimatedTimeInSecs,
    expiry: q.expiry,
    priceImpact: q.priceImpact ?? undefined,
    affiliateApplied: ctx.affiliateApplied
  }
}

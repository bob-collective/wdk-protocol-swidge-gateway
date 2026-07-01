// Raw wire shapes (loose typing — gateway API response)
interface FeeEntry {
  amount?: string
}

interface FeeBreakdown {
  solverFee?: FeeEntry
  inclusionFee?: FeeEntry
  protocolFee?: FeeEntry
  affiliateFee?: FeeEntry
  [key: string]: unknown
}

interface InnerQuote {
  inputAmount: { amount: string }
  outputAmount: { amount: string }
  outputAmountMin?: { amount: string }
  feeBreakdown?: FeeBreakdown
  estimatedTimeInSecs?: number
  expiry?: unknown
  // The gateway returns priceImpact as a string (e.g. '-0.0050'); WDK types it as number.
  // We preserve the string so callers can format it without floating-point loss.
  priceImpact?: string | null
}

interface GatewayQuoteV3 {
  onramp?: InnerQuote
  offramp?: InnerQuote
  tokenSwap?: InnerQuote
  [key: string]: unknown
}

/**
 * Pick the inner quote object from the GatewayQuoteV3 discriminated union.
 */
function inner(gw: GatewayQuoteV3): InnerQuote {
  const q = gw.onramp || gw.offramp || gw.tokenSwap || (gw as unknown as InnerQuote)
  return q
}

/**
 * Sum two optional string amounts as BigInt, returning 0n if both are absent.
 */
function sumAmounts(a: string | undefined, b: string | undefined): bigint {
  return (a != null ? BigInt(a) : 0n) + (b != null ? BigInt(b) : 0n)
}

export interface LocalFee {
  type: string
  amount: bigint
}

export interface LocalSwidgeQuote {
  fromTokenAmount: bigint
  toTokenAmount: bigint
  toTokenAmountMin: bigint
  fees: LocalFee[]
  estimatedDuration: number | undefined
  expiry: unknown
  // Preserved as string from the wire; cast to number at the SwidgeProtocol boundary.
  priceImpact: string | undefined
  affiliateApplied: boolean
}

/**
 * Map a GatewayQuoteV3 wire object to a LocalSwidgeQuote.
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
 */
export function toSwidgeQuote(
  gatewayQuote: GatewayQuoteV3,
  ctx: { affiliateApplied: boolean }
): LocalSwidgeQuote {
  const q = inner(gatewayQuote)
  const fb = q.feeBreakdown || {}

  const fees: LocalFee[] = []

  const networkAmount = sumAmounts(fb.solverFee?.amount, fb.inclusionFee?.amount)
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
    affiliateApplied: ctx.affiliateApplied,
  }
}

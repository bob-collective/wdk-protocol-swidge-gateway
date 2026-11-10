import type { SwidgeFee, SwidgeFeeType, SwidgeQuote } from '@tetherto/wdk-wallet/protocols'
import { GatewaySwidgeError, ERR } from '../errors.js'

// Raw wire shapes (loose typing — gateway API response). All camelCase on the wire.

/** `GatewayTokenAmountV2`: an amount in base units of `address` on `chain`, plus its USD value. */
export interface WireTokenAmount {
  amount: string
  address?: string
  chain?: string
  /** USD value of `amount`; null/absent when the gateway has no price feed for the token. */
  usd?: string | null
}

interface InnerQuote {
  inputAmount: WireTokenAmount
  outputAmount: WireTokenAmount
  feeBreakdown?: Record<string, WireTokenAmount | string | undefined>
  /** Basis points. The onramp quote sends it as a string, offramp/tokenSwap as a number. */
  slippage?: number | string
  estimatedTimeInSecs?: number | null
  /** Fraction as a string, e.g. `'-0.0050'` — negative is a loss. Absent without a price feed. */
  priceImpact?: string | null
}

export interface GatewayQuoteV4 {
  onramp?: InnerQuote
  offramp?: InnerQuote
  tokenSwap?: InnerQuote
  [key: string]: unknown
}

/** `SwidgeQuote` plus whether the configured affiliates were sent with the quote request. */
export type GatewaySwidgeQuote = SwidgeQuote & {
  /** False on token-swap routes, where the gateway takes no affiliate fee. */
  affiliateApplied: boolean
}

/** A non-zero fee line, with the USD value the fee-cap check needs. */
export interface FeeLine extends SwidgeFee {
  usd: string | null | undefined
}

/**
 * Fee-breakdown keys, in display order. Onramp quotes carry solver/execution/layerzero/protocol/
 * affiliate; offramp quotes carry solver/inclusion/protocol/affiliate; token swaps carry none
 * (their top-level `fees` is a zero placeholder — costs are priced into `outputAmount`).
 */
const FEE_KEYS: [key: string, type: SwidgeFeeType, description: string][] = [
  ['solverFee', 'network', 'Solver fee'],
  ['inclusionFee', 'network', 'Bitcoin transaction inclusion fee'],
  ['executionFee', 'network', 'Destination-chain execution fee'],
  ['layerzeroFee', 'network', 'LayerZero messaging fee'],
  ['protocolFee', 'protocol', 'Gateway protocol fee'],
  ['affiliateFee', 'affiliate', 'Affiliate fee'],
]

const BPS = 10_000n

/**
 * A quote amount in base units. Anything but a plain decimal integer string is refused as a
 * `GatewaySwidgeError` (`GATEWAY_HTTP_ERROR`): `BigInt` alone would read `''` as 0 and also take
 * hex or padded strings, and it throws a bare `SyntaxError` on the rest.
 */
function wireAmount(field: string, value: unknown, gw: GatewayQuoteV4): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new GatewaySwidgeError(
    ERR.HTTP,
    `quote ${field} is not an integer amount in base units: ${value}`,
    { cause: gw }
  )
}

/** The inner quote of a `GatewayQuoteV4` — whichever variant key is present. */
export function innerQuote(gw: GatewayQuoteV4): InnerQuote {
  return gw.onramp || gw.offramp || gw.tokenSwap || (gw as unknown as InnerQuote)
}

/**
 * Non-zero fees of a quote, one line per fee-breakdown entry. Entries are never summed: each is
 * denominated in its own token (an offramp's solver fee is USDT, its inclusion fee is BTC sats).
 * An amount entry under a key not in `FEE_KEYS` becomes an `other` line named after its key, so
 * a fee the gateway adds later still shows up — and still counts against the network cap.
 *
 * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if a fee amount is not a plain decimal integer.
 */
export function feeLines(gw: GatewayQuoteV4): FeeLine[] {
  const fb = innerQuote(gw).feeBreakdown || {}
  const known = new Set(FEE_KEYS.map(([key]) => key))
  const entries: [key: string, type: SwidgeFeeType, description: string][] = [
    ...FEE_KEYS,
    ...Object.keys(fb)
      .filter((key) => !known.has(key))
      .map((key): [string, SwidgeFeeType, string] => [key, 'other', key]),
  ]
  const lines: FeeLine[] = []
  for (const [key, type, description] of entries) {
    const entry = fb[key]
    if (!entry || typeof entry !== 'object') continue
    const fee = entry as WireTokenAmount
    if (fee.amount == null) continue
    const amount = wireAmount(`feeBreakdown.${key}.amount`, fee.amount, gw)
    if (amount === 0n) continue
    lines.push({
      type,
      amount,
      token: fee.address ?? '',
      chain: fee.chain,
      included: true,
      description,
      usd: fee.usd,
    })
  }
  return lines
}

/**
 * The slippage the gateway echoes in the quote, in basis points, or null when it is absent or not
 * an integer in [0, 10000]. The onramp quote sends it as a string, offramp/tokenSwap as a number;
 * a string must be plain digits (`Number('')` would otherwise read as 0 bps).
 */
export function quoteSlippageBps(gw: GatewayQuoteV4): number | null {
  const { slippage } = innerQuote(gw)
  const bps =
    typeof slippage === 'number' || (typeof slippage === 'string' && /^\d+$/.test(slippage))
      ? Number(slippage)
      : NaN
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : null
}

/** `outputAmount × (1 − slippage)`; the estimate itself when the quote carries no slippage. */
function minOutput(output: bigint, bps: number | null): bigint {
  return bps === null ? output : (output * (BPS - BigInt(bps))) / BPS
}

/**
 * Map a `GatewayQuoteV4` wire object to a WDK `SwidgeQuote`.
 *
 * - `toTokenAmountMin` is `outputAmount × (1 − slippage)`, using the slippage the gateway echoes.
 * - `fees` lists every non-zero fee-breakdown entry in its own token; all are already deducted
 *   from `toTokenAmount` (`included: true`).
 * - `priceImpact` is the gateway's fraction as a number — negative means a loss.
 *
 * @param gatewayQuote - get-quote response.
 * @param ctx - Whether affiliates were sent with the quote request.
 * @returns The mapped quote.
 * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if an input, output or fee amount is not a
 *   plain decimal integer.
 */
export function toSwidgeQuote(
  gatewayQuote: GatewayQuoteV4,
  ctx: { affiliateApplied: boolean }
): GatewaySwidgeQuote {
  const q = innerQuote(gatewayQuote)
  const toTokenAmount = wireAmount('outputAmount.amount', q.outputAmount?.amount, gatewayQuote)
  const priceImpact = q.priceImpact == null ? undefined : Number(q.priceImpact)
  return {
    fromTokenAmount: wireAmount('inputAmount.amount', q.inputAmount?.amount, gatewayQuote),
    toTokenAmount,
    toTokenAmountMin: minOutput(toTokenAmount, quoteSlippageBps(gatewayQuote)),
    fees: feeLines(gatewayQuote).map(({ usd: _usd, ...fee }) => fee),
    estimatedDuration: q.estimatedTimeInSecs ?? undefined,
    priceImpact: Number.isFinite(priceImpact) ? priceImpact : undefined,
    affiliateApplied: ctx.affiliateApplied,
  }
}

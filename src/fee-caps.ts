import { MaximumFeeExceededError, ValueError } from '@tetherto/wdk-wallet/protocols'
import type { SwidgeFeeType, SwidgeProtocolConfig } from '@tetherto/wdk-wallet/protocols'
import { feeLines, innerQuote } from './map/quote.js'
import type { GatewayQuoteV4 } from './map/quote.js'

/**
 * Fee types each cap covers. `other` (a fee-breakdown key this module doesn't know yet) counts
 * against every cap, so a newly added gateway fee can't slip past whichever cap is set.
 */
const CAPS: [cap: keyof SwidgeProtocolConfig, label: string, types: SwidgeFeeType[]][] = [
  ['maxNetworkFeeBps', 'network', ['network', 'other']],
  ['maxProtocolFeeBps', 'protocol', ['protocol', 'other']],
]

/** USD amounts are compared as fixed-point integers with this many decimals — no float drift. */
const USD_DECIMALS = 18
const USD_UNIT = 10n ** BigInt(USD_DECIMALS)
/**
 * The gateway rounds every `usd` to the nearest cent, so a reported value can be off by up to
 * half a cent either way — a sub-cent fee comes through as `'0'`. Fees are counted at that upper
 * bound and the input at its lower bound, so rounding can only make the check stricter.
 */
const USD_ROUNDING = USD_UNIT / 200n
/** Caps may be fractional bps; they are compared in millionths of a bp. */
const CAP_SCALE = 1_000_000

/** A gateway `usd` string as fixed-point, or null unless it is a plain non-negative decimal. */
function usdValue(usd: unknown): bigint | null {
  if (typeof usd !== 'string') return null
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(usd)
  if (!m) return null
  return BigInt(m[1]) * USD_UNIT + BigInt((m[2] ?? '').padEnd(USD_DECIMALS, '0'))
}

function formatUsd(v: bigint): string {
  const s = v.toString().padStart(USD_DECIMALS + 1, '0')
  const frac = s.slice(-USD_DECIMALS).replace(/0+$/, '')
  return frac ? `${s.slice(0, -USD_DECIMALS)}.${frac}` : s.slice(0, -USD_DECIMALS)
}

/**
 * Whether a fee breakdown carries at least one fee amount. `{}`, a non-object, or one holding only
 * non-fee entries (`fastestFeeRate`) yields no fee lines, so it is as unverifiable as none at all.
 */
function hasFeeEntry(breakdown: unknown): boolean {
  return (
    breakdown !== null &&
    typeof breakdown === 'object' &&
    Object.values(breakdown).some(
      (entry) => entry !== null && typeof entry === 'object' && 'amount' in entry
    )
  )
}

/** The fee token's USD price may drift this far from the input's: 1%, in hundredths. */
const PRICE_DRIFT = 101n

/**
 * Whether `feeUsd` is provably more than `bps` of `inputUsd` — gateway `usd` strings — or null
 * when either is not a plain decimal. The opposite leniency of the caps: this binds a quoted fee
 * to the rate the request asked for rather than enforcing a caller's limit, so it only flags a
 * fee clearly over that rate — each value read at the end of its cent rounding that favours the
 * quote, plus 1% for the fee token's USD price drifting from the input's.
 */
export function exceedsBps(feeUsd: unknown, inputUsd: unknown, bps: number): boolean | null {
  const fee = usdValue(feeUsd)
  const input = usdValue(inputUsd)
  if (fee == null || input == null) return null
  const rate = BigInt(Math.round(bps * CAP_SCALE))
  return (
    (fee - USD_ROUNDING) * 10_000n * BigInt(CAP_SCALE) * 100n >
    (input + USD_ROUNDING) * rate * PRICE_DRIFT
  )
}

/** A cap in millionths of a bp, or `ValueError` unless it is a finite, non-negative number. */
function scaledCap(cap: string, value: unknown): bigint {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new ValueError(`${cap} must be a finite, non-negative number of bps, got ${value}`)
  }
  return typeof value === 'bigint' ? value * BigInt(CAP_SCALE) : BigInt(Math.round(n * CAP_SCALE))
}

/**
 * Enforce `maxNetworkFeeBps` / `maxProtocolFeeBps` against a quote, before an order is created.
 *
 * The caps are basis points of the input amount, but gateway fees are denominated in other tokens
 * than the input (an offramp's inclusion fee is BTC sats, its solver fee USDT), so fees and input
 * are compared by their gateway-reported USD values — each fee line at the top of its cent
 * rounding, the input at the bottom of its own. The check fails closed: with a cap set, a missing
 * fee breakdown on an onramp/offramp, or a missing USD value on the input or on any non-zero fee
 * it covers, refuses the swidge rather than letting the cap go unchecked. Affiliate fees are not
 * capped: they go to the integrator's configured affiliates, and the swidge refuses a quote that
 * pays anyone else, charges one the request didn't ask for, or charges more than the requested
 * bps (see `exceedsBps`). Token-swap quotes report no fee
 * breakdown — their costs are priced into the output — so the caps have nothing to check there;
 * bound those with `minAmountOut` or `slippage`.
 *
 * @param gw - get-quote response, holding exactly the `variant` key.
 * @param variant - The route's quote variant.
 * @param caps - Fee caps; an unset cap is not checked.
 * @throws {ValueError} If a set cap is not a finite, non-negative number.
 * @throws {MaximumFeeExceededError} If a fee exceeds its cap, or a set cap cannot be verified.
 */
export function assertFeeCaps(
  gw: GatewayQuoteV4,
  variant: 'onramp' | 'offramp' | 'tokenSwap',
  caps: SwidgeProtocolConfig
): void {
  const active = CAPS.filter(([cap]) => caps[cap] != null)
  if (active.length === 0) return

  const inner = innerQuote(gw)
  const lines = feeLines(gw)
  const reportedInput = usdValue(inner.inputAmount.usd)

  for (const [cap, label, types] of active) {
    const limit = scaledCap(cap, caps[cap])
    if (variant !== 'tokenSwap' && !hasFeeEntry(inner.feeBreakdown)) {
      throw new MaximumFeeExceededError(
        `cannot verify ${cap}: the ${variant} quote has no fee breakdown`,
        {}
      )
    }
    const fees = lines.filter((f) => types.includes(f.type))
    if (fees.length === 0) continue
    if (reportedInput == null || reportedInput <= USD_ROUNDING) {
      throw new MaximumFeeExceededError(
        `cannot verify ${cap}: the quote has no USD price for the input amount`,
        {}
      )
    }
    const inputUsd = reportedInput - USD_ROUNDING
    let feeUsd = 0n
    for (const fee of fees) {
      const usd = usdValue(fee.usd)
      if (usd == null) {
        throw new MaximumFeeExceededError(
          `cannot verify ${cap}: the quote has no USD price for the ${fee.description?.toLowerCase()}`,
          {}
        )
      }
      feeUsd += usd + USD_ROUNDING
    }
    if (feeUsd * 10_000n * BigInt(CAP_SCALE) > limit * inputUsd) {
      const bps = ((Number(feeUsd) / Number(inputUsd)) * 10_000).toFixed(1)
      throw new MaximumFeeExceededError(
        `${label} fee of up to ${bps} bps ($${formatUsd(feeUsd)} on ` +
          `$${formatUsd(reportedInput)}) exceeds ${cap} (${caps[cap]})`,
        {}
      )
    }
  }
}

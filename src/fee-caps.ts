import { MaximumFeeExceededError, ValueError } from '@tetherto/wdk-wallet/protocols'
import type { SwidgeFeeType, SwidgeProtocolConfig } from '@tetherto/wdk-wallet/protocols'
import { feeLines, innerQuote } from './map/quote.js'
import type { GatewayQuoteV4 } from './map/quote.js'

/**
 * Fee types each cap covers. `other` (a fee-breakdown key this module doesn't know yet) counts
 * against the network cap, so a newly added gateway fee can't slip past a cap unchecked.
 */
const CAPS: [cap: keyof SwidgeProtocolConfig, label: string, types: SwidgeFeeType[]][] = [
  ['maxNetworkFeeBps', 'network', ['network', 'other']],
  ['maxProtocolFeeBps', 'protocol', ['protocol']],
]

/** A finite, non-negative number parsed from a gateway `usd` string, or null. */
function usdValue(usd: string | null | undefined): number | null {
  if (usd == null) return null
  const n = Number(usd)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Enforce `maxNetworkFeeBps` / `maxProtocolFeeBps` against a quote, before an order is created.
 *
 * The caps are basis points of the input amount, but gateway fees are denominated in other tokens
 * than the input (an offramp's inclusion fee is BTC sats, its solver fee USDT), so fees and input
 * are compared by their gateway-reported USD values. The check fails closed: with a cap set, a
 * missing USD value on the input or on any non-zero fee it covers refuses the swidge rather than
 * letting the cap go unchecked. Affiliate fees are configured by the integrator and are not
 * capped. Token-swap quotes report no fee breakdown — their costs are priced into the output —
 * so the caps have nothing to check there; bound those with `minAmountOut` or `slippage`.
 *
 * @param gw - get-quote response.
 * @param caps - Fee caps; an unset cap is not checked.
 * @throws {ValueError} If a set cap is not a finite, non-negative number.
 * @throws {MaximumFeeExceededError} If a fee exceeds its cap, or a set cap cannot be verified.
 */
export function assertFeeCaps(gw: GatewayQuoteV4, caps: SwidgeProtocolConfig): void {
  const active = CAPS.filter(([cap]) => caps[cap] != null)
  if (active.length === 0) return

  const lines = feeLines(gw)
  const inputUsd = usdValue(innerQuote(gw).inputAmount.usd)

  for (const [cap, label, types] of active) {
    const limit = Number(caps[cap])
    if (!Number.isFinite(limit) || limit < 0) {
      throw new ValueError(`${cap} must be a finite, non-negative number of bps, got ${caps[cap]}`)
    }
    const fees = lines.filter((f) => types.includes(f.type))
    if (fees.length === 0) continue
    if (inputUsd == null || inputUsd === 0) {
      throw new MaximumFeeExceededError(
        `cannot verify ${cap}: the quote has no USD price for the input amount`,
        {}
      )
    }
    let feeUsd = 0
    for (const fee of fees) {
      const usd = usdValue(fee.usd)
      if (usd == null) {
        throw new MaximumFeeExceededError(
          `cannot verify ${cap}: the quote has no USD price for the ${fee.description?.toLowerCase()}`,
          {}
        )
      }
      feeUsd += usd
    }
    const bps = (feeUsd / inputUsd) * 10_000
    if (bps > limit) {
      throw new MaximumFeeExceededError(
        `${label} fee of ${bps.toFixed(1)} bps ($${feeUsd} on $${inputUsd}) exceeds ${cap} (${limit})`,
        {}
      )
    }
  }
}

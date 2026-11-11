import { chainInfo } from '../chains.js'
import { TOKENS } from '../tokens.js'
import type { SwidgeSupportedChain, SwidgeSupportedToken } from '@tetherto/wdk-wallet/protocols'

export interface RouteInfo {
  srcChain: string
  dstChain: string
  srcToken: string
  dstToken: string
}

/** Key into `TOKENS`: `<chain>:<token>`, both lower-cased. */
export function tokenKey(chain: string, token: string): string {
  return `${chain.toLowerCase()}:${token.toLowerCase()}`
}

function chainEntry(id: string): SwidgeSupportedChain {
  const { name, type, nativeToken } = chainInfo(id)
  return { id, name, type, nativeToken }
}

/**
 * Extract unique chains from a routes list, with names and native tokens from `CHAINS`.
 */
export function toSupportedChains(routes: RouteInfo[]): SwidgeSupportedChain[] {
  const map = new Map<string, SwidgeSupportedChain>()
  for (const r of routes) {
    for (const id of [r.srcChain, r.dstChain]) {
      if (!map.has(id)) map.set(id, chainEntry(id))
    }
  }
  return [...map.values()]
}

/**
 * Extract unique (chain, token) pairs from a routes list, with symbol/decimals/name from `TOKENS`.
 *
 * get-routes returns addresses only, so metadata comes from the generated `src/tokens.ts`. A token
 * missing from that table is left out — `symbol` and `decimals` are required, and a guess would
 * mis-scale amounts. The validate lane fails when the live route matrix has such a token.
 */
export function toSupportedTokens(
  routes: RouteInfo[],
  opts: { fromChain?: string } = {}
): SwidgeSupportedToken[] {
  const out: SwidgeSupportedToken[] = []
  const seen = new Set<string>()
  for (const r of routes) {
    for (const [chain, token] of [
      [r.srcChain, r.srcToken],
      [r.dstChain, r.dstToken],
    ]) {
      if (opts.fromChain && opts.fromChain !== chain) continue
      const key = tokenKey(chain, token)
      if (seen.has(key)) continue
      seen.add(key)
      const info = TOKENS[key]
      if (!info) continue
      out.push({ token, chain, address: token, ...info })
    }
  }
  return out
}

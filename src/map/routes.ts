import { chainFamily } from '../chains.js'
import type { SwidgeSupportedChain, SwidgeSupportedToken } from '@tetherto/wdk-wallet/protocols'

const FAMILY_TO_TYPE: Record<string, 'utxo' | 'svm' | 'evm'> = {
  bitcoin: 'utxo',
  solana: 'svm',
  tron: 'evm',
  evm: 'evm',
}

function chainEntry(id: string): SwidgeSupportedChain {
  const family = chainFamily(id)
  return {
    id,
    name: id,
    type: FAMILY_TO_TYPE[family] || 'evm',
    nativeToken: family === 'bitcoin' ? 'BTC' : 'ETH',
  }
}

export interface RouteInfo {
  srcChain: string
  dstChain: string
  srcToken: string
  dstToken: string
}

/**
 * Extract unique chains from a routes list.
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
 * Extract unique (chain, tokenAddress) pairs from a routes list.
 *
 * NOTE: The get-routes response only provides token addresses — no symbol or decimals.
 * Callers that need token metadata must fetch it separately (e.g. from the token list or
 * an on-chain call). symbol/decimals are intentionally omitted from the returned objects.
 *
 * The return type is cast to `SwidgeSupportedToken[]` even though `symbol` and `decimals`
 * are absent from the objects — the gateway API does not provide them. Callers should treat
 * these fields as absent and not rely on them.
 */
export function toSupportedTokens(
  routes: RouteInfo[],
  opts?: { fromChain?: string }
): SwidgeSupportedToken[] {
  const options = opts || {}
  const out: { token: string; chain: string; address: string }[] = []
  const seen = new Set<string>()
  for (const r of routes) {
    for (const [chain, tokenAddress] of [
      [r.srcChain, r.srcToken],
      [r.dstChain, r.dstToken],
    ]) {
      if (options.fromChain && options.fromChain !== chain) continue
      const key = `${chain}:${tokenAddress}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ token: tokenAddress, chain, address: tokenAddress })
    }
  }
  // Cast: symbol and decimals are absent (not provided by the API); see function doc.
  return out as unknown as SwidgeSupportedToken[]
}

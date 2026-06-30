'use strict'

import { chainFamily } from '../chains.js'

/** @type {Record<string, 'utxo'|'svm'|'evm'>} */
const FAMILY_TO_TYPE = { bitcoin: 'utxo', solana: 'svm', tron: 'evm', evm: 'evm' }

/**
 * @param {string} id
 * @returns {{ id: string, name: string, type: 'utxo'|'svm'|'evm', nativeToken: string }}
 */
function chainEntry (id) {
  const family = chainFamily(id)
  return {
    id,
    name: id,
    type: FAMILY_TO_TYPE[family] || 'evm',
    nativeToken: family === 'bitcoin' ? 'BTC' : 'ETH'
  }
}

/**
 * @typedef {{ srcChain: string, dstChain: string, srcToken: string, dstToken: string }} RouteInfo
 */

/**
 * Extract unique chains from a routes list.
 * @param {RouteInfo[]} routes
 * @returns {{ id: string, name: string, type: 'utxo'|'svm'|'evm', nativeToken: string }[]}
 */
export function toSupportedChains (routes) {
  const map = new Map()
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
 * @param {RouteInfo[]} routes
 * @param {{ fromChain?: string }} [opts]
 * @returns {{ token: string, chain: string, address: string }[]}
 */
export function toSupportedTokens (routes, opts) {
  const options = opts || {}
  const out = []
  const seen = new Set()
  for (const r of routes) {
    for (const [chain, tokenAddress] of [[r.srcChain, r.srcToken], [r.dstChain, r.dstToken]]) {
      if (options.fromChain && options.fromChain !== chain) continue
      const key = `${chain}:${tokenAddress}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ token: tokenAddress, chain, address: tokenAddress })
    }
  }
  return out
}

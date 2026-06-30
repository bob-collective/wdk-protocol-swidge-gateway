'use strict'

/** @param {string} chain @returns {'bitcoin'|'evm'|'tron'|'solana'} */
export function chainFamily (chain) {
  const c = String(chain).toLowerCase()
  if (c === 'bitcoin' || c === 'btc') return 'bitcoin'
  if (c === 'tron') return 'tron'
  if (c === 'solana') return 'solana'
  return 'evm'
}

/** @param {{ srcFamily: string, dstFamily: string }} f @returns {'onramp'|'offramp'|'tokenSwap'} */
export function detectVariant ({ srcFamily, dstFamily }) {
  if (srcFamily === 'bitcoin') return 'onramp'
  if (dstFamily === 'bitcoin') return 'offramp'
  return 'tokenSwap'
}

export type ChainFamily = 'bitcoin' | 'evm' | 'tron' | 'solana'
export type SwidgeVariant = 'onramp' | 'offramp' | 'tokenSwap'

export function chainFamily(chain: string): ChainFamily {
  const c = String(chain).toLowerCase()
  if (c === 'bitcoin' || c === 'btc') return 'bitcoin'
  if (c === 'tron') return 'tron'
  if (c === 'solana') return 'solana'
  return 'evm'
}

export function detectVariant({
  srcFamily,
  dstFamily,
}: {
  srcFamily: string
  dstFamily: string
}): SwidgeVariant {
  if (srcFamily === 'bitcoin') return 'onramp'
  if (dstFamily === 'bitcoin') return 'offramp'
  return 'tokenSwap'
}

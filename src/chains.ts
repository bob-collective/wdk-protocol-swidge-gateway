export type ChainFamily = 'bitcoin' | 'evm' | 'tron' | 'solana'
export type SwidgeVariant = 'onramp' | 'offramp' | 'tokenSwap'

/** Display metadata for a Gateway chain. */
export interface ChainInfo {
  /** Human-readable chain name. */
  name: string
  /** Virtual-machine / ledger type, as `SwidgeSupportedChain.type` expects it. */
  type: 'utxo' | 'evm' | 'tvm' | 'svm'
  /** Symbol of the chain's native (gas) token. */
  nativeToken: string
  /** Full name of the native token. */
  nativeName: string
  /** Decimal places of the native token's base unit. */
  nativeDecimals: number
}

const ETHER = { nativeToken: 'ETH', nativeName: 'Ether', nativeDecimals: 18 } as const
const HYPEREVM: ChainInfo = {
  name: 'HyperEVM',
  type: 'evm',
  nativeToken: 'HYPE',
  nativeName: 'Hyperliquid',
  nativeDecimals: 18,
}

/**
 * Chains the Gateway routes over, keyed by Gateway chain id. A chain missing here still works for
 * swidges; it only gets generic metadata from `chainInfo`, and the validate lane flags it.
 */
export const CHAINS: Record<string, ChainInfo> = {
  bitcoin: {
    name: 'Bitcoin',
    type: 'utxo',
    nativeToken: 'BTC',
    nativeName: 'Bitcoin',
    nativeDecimals: 8,
  },
  ethereum: { name: 'Ethereum', type: 'evm', ...ETHER },
  base: { name: 'Base', type: 'evm', ...ETHER },
  arbitrum: { name: 'Arbitrum One', type: 'evm', ...ETHER },
  bob: { name: 'BOB', type: 'evm', ...ETHER },
  unichain: { name: 'Unichain', type: 'evm', ...ETHER },
  robinhood: { name: 'Robinhood Chain', type: 'evm', ...ETHER },
  bsc: {
    name: 'BNB Smart Chain',
    type: 'evm',
    nativeToken: 'BNB',
    nativeName: 'BNB',
    nativeDecimals: 18,
  },
  avalanche: {
    name: 'Avalanche C-Chain',
    type: 'evm',
    nativeToken: 'AVAX',
    nativeName: 'Avalanche',
    nativeDecimals: 18,
  },
  polygon: {
    name: 'Polygon',
    type: 'evm',
    nativeToken: 'POL',
    nativeName: 'Polygon Ecosystem Token',
    nativeDecimals: 18,
  },
  hyperevm: HYPEREVM,
  // Staging names the same chain (id 999) `hyperliquid`; accept both spellings.
  hyperliquid: HYPEREVM,
  plasma: {
    name: 'Plasma',
    type: 'evm',
    nativeToken: 'XPL',
    nativeName: 'Plasma',
    nativeDecimals: 18,
  },
  tron: { name: 'Tron', type: 'tvm', nativeToken: 'TRX', nativeName: 'Tronix', nativeDecimals: 6 },
  solana: {
    name: 'Solana',
    type: 'svm',
    nativeToken: 'SOL',
    nativeName: 'Solana',
    nativeDecimals: 9,
  },
}

const FAMILY_TYPE: Record<ChainFamily, ChainInfo['type']> = {
  bitcoin: 'utxo',
  evm: 'evm',
  tron: 'tvm',
  solana: 'svm',
}

/**
 * Metadata for a Gateway chain id. Unknown chains fall back to the raw id as the name and the
 * family's VM type; `nativeToken` is left empty rather than guessed.
 *
 * @param chain - Gateway chain id (e.g. `base`, `bitcoin`).
 * @returns The chain's display metadata.
 */
export function chainInfo(chain: string): ChainInfo {
  const id = String(chain).toLowerCase()
  if (Object.hasOwn(CHAINS, id)) return CHAINS[id]
  return {
    name: chain,
    type: FAMILY_TYPE[chainFamily(chain)],
    nativeToken: '',
    nativeName: '',
    nativeDecimals: 0,
  }
}

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

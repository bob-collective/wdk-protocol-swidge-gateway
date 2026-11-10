/**
 * Regenerate `src/tokens.ts` — symbol / decimals / name for every token in the live Gateway route
 * matrix. `get-routes` returns addresses only, and `SwidgeSupportedToken` requires `symbol` and
 * `decimals`, so the module ships this table. The validate lane fails when a live route token is
 * missing from it; run this script to catch up:
 *
 *   pnpm gen:tokens
 *
 * Reads ERC-20 / TRC-20 metadata over public RPCs (override per chain with `<CHAIN>_RPC_URL`,
 * e.g. `ROBINHOOD_RPC_URL`). Native assets (the zero address) come from `CHAINS` in
 * `src/chains.ts`. Must run from a region the Gateway API does not geo-block (see AGENTS.md).
 */
import { writeFileSync } from 'node:fs'
import { CHAINS } from '../src/chains.js'

const API = process.env.GATEWAY_API_URL ?? 'https://gateway-api-mainnet.gobob.xyz'
const ZERO = '0x0000000000000000000000000000000000000000'
const OUT = new URL('../src/tokens.ts', import.meta.url)

const RPC: Record<string, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  unichain: 'https://unichain-rpc.publicnode.com',
  bob: 'https://rpc.gobob.xyz',
  hyperevm: 'https://rpc.hyperliquid.xyz/evm',
  plasma: 'https://rpc.plasma.to',
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
  tron: 'https://tron-rpc.publicnode.com',
}

const SELECTOR = { name: '06fdde03', symbol: '95d89b41', decimals: '313ce567' } as const

interface Route {
  srcChain: string
  dstChain: string
  srcToken: string
  dstToken: string
}

interface TokenMeta {
  symbol: string
  decimals: number
  name: string
}

function rpcUrl(chain: string): string {
  const url = process.env[`${chain.toUpperCase()}_RPC_URL`] ?? RPC[chain]
  if (!url) throw new Error(`no RPC for chain "${chain}": set ${chain.toUpperCase()}_RPC_URL`)
  return url
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

/** Raw return data of a no-argument view call, as hex without `0x`. */
async function call(
  chain: string,
  address: string,
  method: keyof typeof SELECTOR
): Promise<string> {
  if (chain === 'tron') {
    const r = (await postJson(`${rpcUrl(chain)}/wallet/triggerconstantcontract`, {
      owner_address: address,
      contract_address: address,
      function_selector: `${method}()`,
      visible: true,
    })) as { constant_result?: string[]; result?: { result?: boolean; message?: string } }
    if (r.result?.result !== true || !r.constant_result?.[0]) {
      throw new Error(`tron ${address} ${method}(): ${JSON.stringify(r.result)}`)
    }
    return r.constant_result[0]
  }
  const r = (await postJson(rpcUrl(chain), {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: address, data: `0x${SELECTOR[method]}` }, 'latest'],
  })) as { result?: string; error?: { message?: string } }
  if (!r.result || r.result === '0x') {
    throw new Error(`${chain} ${address} ${method}(): ${r.error?.message ?? 'empty result'}`)
  }
  return r.result.slice(2)
}

/** Decode an ABI `string` return — or a `bytes32` one, which some older tokens (e.g. MKR) use. */
function decodeString(hex: string): string {
  if (hex.length === 64) return Buffer.from(hex, 'hex').toString('utf8').replace(/\0+$/, '')
  const offset = Number(BigInt('0x' + hex.slice(0, 64))) * 2
  const len = Number(BigInt('0x' + hex.slice(offset, offset + 64)))
  return Buffer.from(hex.slice(offset + 64, offset + 64 + len * 2), 'hex').toString('utf8')
}

async function erc20Meta(chain: string, address: string): Promise<TokenMeta> {
  const [symbol, decimals, name] = await Promise.all([
    call(chain, address, 'symbol').then(decodeString),
    call(chain, address, 'decimals').then((h) => Number(BigInt('0x' + h.slice(0, 64)))),
    call(chain, address, 'name').then(decodeString),
  ])
  return { symbol, decimals, name }
}

function nativeMeta(chain: string): TokenMeta {
  const info = CHAINS[chain]
  if (!info?.nativeDecimals) throw new Error(`no native token metadata for chain "${chain}"`)
  return { symbol: info.nativeToken, decimals: info.nativeDecimals, name: info.nativeName }
}

async function main(): Promise<void> {
  const res = await fetch(`${API}/v4/get-routes`)
  if (!res.ok) throw new Error(`get-routes: HTTP ${res.status}`)
  const routes = (await res.json()) as Route[]

  const pairs = new Map<string, [string, string]>()
  for (const r of routes) {
    for (const [chain, token] of [
      [r.srcChain, r.srcToken],
      [r.dstChain, r.dstToken],
    ]) {
      pairs.set(`${chain}:${token.toLowerCase()}`, [chain, token])
    }
  }

  const entries: [string, TokenMeta][] = []
  for (const [key, [chain, token]] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = token.toLowerCase() === ZERO ? nativeMeta(chain) : await erc20Meta(chain, token)
    entries.push([key, meta])
    console.error(`${key} → ${meta.symbol} (${meta.decimals})`)
  }

  const body = entries
    .map(
      ([key, m]) =>
        `  ${JSON.stringify(key)}: { symbol: ${JSON.stringify(m.symbol)}, decimals: ${m.decimals}, name: ${JSON.stringify(m.name)} },`
    )
    .join('\n')

  writeFileSync(
    OUT,
    `// Generated by \`pnpm gen:tokens\` (scripts/gen-tokens.ts) from the live get-routes matrix.
// Do not edit by hand — rerun the script when the validate lane reports a missing token.

/** Display metadata for a Gateway route token. */
export interface TokenInfo {
  /** Ticker symbol, as the token contract reports it. */
  symbol: string
  /** Decimal places of the token's base unit. */
  decimals: number
  /** Full name, as the token contract reports it. */
  name: string
}

/** Route tokens keyed by \`<chain>:<lower-case address>\` — see \`tokenKey\` in src/map/routes.ts. */
export const TOKENS: Record<string, TokenInfo> = {
${body}
}
`
  )
  console.error(`wrote ${entries.length} tokens to ${OUT.pathname}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

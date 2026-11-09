import { describe, test, expect } from 'vitest'
import { toSupportedChains, toSupportedTokens } from '../src/map/routes.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const UNKNOWN_SOLANA = 'So11111111111111111111111111111111111111112'

const ROUTES = [
  { srcChain: 'bitcoin', dstChain: 'base', srcToken: ZERO, dstToken: USDT_BASE },
  { srcChain: 'base', dstChain: 'bitcoin', srcToken: USDT_BASE, dstToken: ZERO },
  { srcChain: 'base', dstChain: 'solana', srcToken: USDT_BASE, dstToken: UNKNOWN_SOLANA },
  { srcChain: 'tron', dstChain: 'bitcoin', srcToken: USDT_TRON, dstToken: ZERO },
  { srcChain: 'bsc', dstChain: 'mystery', srcToken: ZERO, dstToken: ZERO },
]

describe('toSupportedChains', () => {
  test('names, VM types and native tokens come from the chain table', () => {
    expect(toSupportedChains(ROUTES)).toEqual([
      { id: 'bitcoin', name: 'Bitcoin', type: 'utxo', nativeToken: 'BTC' },
      { id: 'base', name: 'Base', type: 'evm', nativeToken: 'ETH' },
      { id: 'solana', name: 'Solana', type: 'svm', nativeToken: 'SOL' },
      { id: 'tron', name: 'Tron', type: 'tvm', nativeToken: 'TRX' },
      { id: 'bsc', name: 'BNB Smart Chain', type: 'evm', nativeToken: 'BNB' },
      // Unknown chain: raw id as name, family VM type, native token not guessed.
      { id: 'mystery', name: 'mystery', type: 'evm', nativeToken: '' },
    ])
  })
})

describe('toSupportedTokens', () => {
  test('carries symbol, decimals and name; drops tokens missing from the table', () => {
    expect(toSupportedTokens(ROUTES)).toEqual([
      { token: ZERO, chain: 'bitcoin', address: ZERO, symbol: 'BTC', decimals: 8, name: 'Bitcoin' },
      {
        token: USDT_BASE,
        chain: 'base',
        address: USDT_BASE,
        symbol: 'USDT',
        decimals: 6,
        name: 'Tether USD',
      },
      {
        token: USDT_TRON,
        chain: 'tron',
        address: USDT_TRON,
        symbol: 'USDT',
        decimals: 6,
        name: 'Tether USD',
      },
      { token: ZERO, chain: 'bsc', address: ZERO, symbol: 'BNB', decimals: 18, name: 'BNB' },
    ])
  })

  test('fromChain filter returns only that chain', () => {
    expect(toSupportedTokens(ROUTES, { fromChain: 'base' }).map((t) => t.token)).toEqual([
      USDT_BASE,
    ])
  })
})

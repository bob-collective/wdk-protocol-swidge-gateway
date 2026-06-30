/* eslint-env jest */
'use strict'

import { toSupportedChains, toSupportedTokens } from '../src/map/routes.js'

const ROUTES = [
  { srcChain: 'bitcoin', dstChain: 'base', srcToken: '0x0000000000000000000000000000000000000000', dstToken: '0xusdt000000000000000000000000000000000001' },
  { srcChain: 'base', dstChain: 'bitcoin', srcToken: '0xusdt000000000000000000000000000000000001', dstToken: '0x0000000000000000000000000000000000000000' },
  { srcChain: 'base', dstChain: 'solana', srcToken: '0xusdt000000000000000000000000000000000001', dstToken: 'So11111111111111111111111111111111111111112' }
]

test('chains include bitcoin as utxo', () => {
  const chains = toSupportedChains(ROUTES)
  expect(chains).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'bitcoin', type: 'utxo' })
  ]))
})

test('chains include base as evm', () => {
  const chains = toSupportedChains(ROUTES)
  expect(chains).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'base', type: 'evm' })
  ]))
})

test('chains include solana as svm', () => {
  const chains = toSupportedChains(ROUTES)
  expect(chains).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'solana', type: 'svm' })
  ]))
})

test('chains are deduplicated', () => {
  const chains = toSupportedChains(ROUTES)
  const ids = chains.map(c => c.id)
  expect(ids.filter(id => id === 'base').length).toBe(1)
})

test('bitcoin chain has nativeToken BTC', () => {
  const chains = toSupportedChains(ROUTES)
  const btc = chains.find(c => c.id === 'bitcoin')
  expect(btc.nativeToken).toBe('BTC')
})

test('evm chain has nativeToken ETH', () => {
  const chains = toSupportedChains(ROUTES)
  const base = chains.find(c => c.id === 'base')
  expect(base.nativeToken).toBe('ETH')
})

test('tokens include dst token with chain', () => {
  const tokens = toSupportedTokens(ROUTES, {})
  expect(tokens).toEqual(expect.arrayContaining([
    expect.objectContaining({ token: '0xusdt000000000000000000000000000000000001', chain: 'base', address: '0xusdt000000000000000000000000000000000001' })
  ]))
})

test('tokens are deduplicated by chain:address', () => {
  const tokens = toSupportedTokens(ROUTES, {})
  const usdt = tokens.filter(t => t.token === '0xusdt000000000000000000000000000000000001' && t.chain === 'base')
  expect(usdt.length).toBe(1)
})

test('tokens fromChain filter returns only matching chain', () => {
  const tokens = toSupportedTokens(ROUTES, { fromChain: 'base' })
  expect(tokens.every(t => t.chain === 'base')).toBe(true)
  expect(tokens.length).toBeGreaterThan(0)
})

test('tokens have no symbol or decimals properties', () => {
  const tokens = toSupportedTokens(ROUTES, {})
  for (const t of tokens) {
    expect(t).not.toHaveProperty('symbol')
    expect(t).not.toHaveProperty('decimals')
  }
})

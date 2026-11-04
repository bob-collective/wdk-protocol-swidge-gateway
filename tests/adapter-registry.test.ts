import { describe, test, expect } from 'vitest'
import { getAdapter } from '../src/chain-adapters/registry.js'

describe('getAdapter', () => {
  test('returns bitcoin + evm + tron adapters', () => {
    expect(getAdapter('bitcoin').family).toBe('bitcoin')
    expect(getAdapter('evm').family).toBe('evm')
    expect(getAdapter('tron').family).toBe('tron')
  })

  test('solana unsupported', () => {
    expect(() => getAdapter('solana')).toThrow(/not supported/i)
  })
})

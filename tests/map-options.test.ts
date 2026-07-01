import { describe, test, expect } from 'vitest'
import { serializeAffiliates, toQuoteParams, resolveTokenId, BTC_ZERO_ADDRESS } from '../src/map/options.js'

describe('serializeAffiliates', () => {
  test('enforces limits', () => {
    expect(serializeAffiliates([{ address: '0xabc', bps: 50 }, { address: '0xdef', bps: 25 }])).toBe(
      '0xabc:50,0xdef:25'
    )
    expect(() => serializeAffiliates([{ address: '0xabc', bps: 0 }])).toThrow(/greater than zero/i)
    expect(() =>
      serializeAffiliates([
        { address: '0xabc', bps: 600 },
        { address: '0xdef', bps: 500 },
      ])
    ).toThrow(/1000/)
    expect(() =>
      serializeAffiliates([
        { address: '0xa', bps: 1 },
        { address: '0xa', bps: 1 },
      ])
    ).toThrow(/duplicate/i)
  })
})

describe('resolveTokenId', () => {
  // The gateway API represents native BTC as the zero-address.
  // 'BTC' (any case) is the ergonomic caller-facing identifier; it must
  // normalise to the zero-address before reaching the API.
  test('maps BTC (any case) to zero-address', () => {
    expect(resolveTokenId('BTC')).toBe(BTC_ZERO_ADDRESS)
    expect(resolveTokenId('btc')).toBe(BTC_ZERO_ADDRESS)
    expect(resolveTokenId('Btc')).toBe(BTC_ZERO_ADDRESS)
  })

  test('passes ERC-20 contract address through unchanged', () => {
    const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    expect(resolveTokenId(usdt)).toBe(usdt)
  })

  test('passes raw zero-address through unchanged (backward compat)', () => {
    expect(resolveTokenId(BTC_ZERO_ADDRESS)).toBe(BTC_ZERO_ADDRESS)
  })
})

describe('toQuoteParams — BTC token normalisation', () => {
  // Callers may pass fromToken: 'BTC' or toToken: 'BTC'; the gateway must
  // receive the zero-address.  Both the ergonomic string and the raw
  // zero-address must produce identical API parameters.
  const baseCtx = { defaultSlippage: 0.03, variant: 'onramp' }
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

  test('fromToken BTC → srcToken is zero-address (onramp)', () => {
    const p = toQuoteParams(
      { fromToken: 'BTC', toToken: USDT, fromChain: 'bitcoin', toChain: 'ethereum', fromTokenAmount: 100000n },
      baseCtx
    )
    expect(p.srcToken).toBe(BTC_ZERO_ADDRESS)
    expect(p.dstToken).toBe(USDT)
  })

  test('toToken BTC → dstToken is zero-address (offramp)', () => {
    const p = toQuoteParams(
      { fromToken: USDT, toToken: 'BTC', fromChain: 'ethereum', toChain: 'bitcoin', fromTokenAmount: 1000000n },
      baseCtx
    )
    expect(p.srcToken).toBe(USDT)
    expect(p.dstToken).toBe(BTC_ZERO_ADDRESS)
  })

  test('toToken btc (lowercase) → dstToken is zero-address', () => {
    const p = toQuoteParams(
      { fromToken: USDT, toToken: 'btc', fromChain: 'ethereum', toChain: 'bitcoin', fromTokenAmount: 1000000n },
      baseCtx
    )
    expect(p.dstToken).toBe(BTC_ZERO_ADDRESS)
  })

  test('ERC-20 addresses pass through unchanged (no mutation)', () => {
    const p = toQuoteParams(
      { fromToken: USDT, toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', fromChain: 'base', toChain: 'base', fromTokenAmount: 500n },
      { ...baseCtx, variant: 'tokenSwap' }
    )
    expect(p.srcToken).toBe(USDT)
    expect(p.dstToken).toBe('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2')
  })
})

describe('toQuoteParams', () => {
  test('drops affiliates on tokenSwap', () => {
    const p = toQuoteParams(
      {
        fromToken: 'USDC',
        toToken: 'USDT',
        toChain: 'base',
        fromChain: 'base',
        fromTokenAmount: 1000n,
        slippage: 0.03,
      },
      {
        fromAddress: '0xfrom',
        ownerAddress: '0xown',
        defaultSlippage: 0.03,
        affiliates: [{ address: '0xbob', bps: 10 }],
        variant: 'tokenSwap',
      }
    )
    expect(p.affiliates).toBeUndefined()
    expect(p.slippage).toBe('300')
    expect(p.amount).toBe('1000')
  })
})

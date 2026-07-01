import { describe, test, expect } from 'vitest'
import { serializeAffiliates, toQuoteParams } from '../src/map/options.js'

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

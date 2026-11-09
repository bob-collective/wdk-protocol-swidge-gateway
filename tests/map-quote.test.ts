import { describe, test, expect } from 'vitest'
import { toSwidgeQuote } from '../src/map/quote.js'

const ZERO = '0x0000000000000000000000000000000000000000'

// Real wire shape: camelCase, feeBreakdown, all amounts are strings
const offrampGw = {
  offramp: {
    inputAmount: { amount: '100000', address: '0xabc', chain: 'ethereum' },
    outputAmount: { amount: '99000', address: ZERO, chain: 'bitcoin' },
    totalFeeUsd: '1.50',
    feeBreakdown: {
      solverFee: { amount: '300', address: '0xabc', chain: 'ethereum' },
      inclusionFee: { amount: '200', address: ZERO, chain: 'bitcoin' },
      protocolFee: { amount: '150', address: '0xabc', chain: 'ethereum' },
      affiliateFee: { amount: '100', address: '0xabc', chain: 'ethereum' },
      fastestFeeRate: '10',
    },
    slippage: 50,
    estimatedTimeInSecs: 600,
    priceImpact: '-0.0050',
  },
}

const onrampGw = {
  onramp: {
    inputAmount: { amount: '50000', address: ZERO, chain: 'bitcoin' },
    outputAmount: { amount: '48000', address: '0xabc', chain: 'bob' },
    feeBreakdown: {
      solverFee: { amount: '500', address: '0xabc', chain: 'bob' },
      protocolFee: { amount: '200', address: '0xabc', chain: 'bob' },
      affiliateFee: { amount: '75', address: '0xabc', chain: 'bob' },
      executionFee: { amount: '100', address: '0xabc', chain: 'bob' },
      layerzeroFee: { amount: '50', address: '0xabc', chain: 'bob' },
    },
    // The onramp quote sends slippage as a string.
    slippage: '100',
    estimatedTimeInSecs: 900,
    priceImpact: null,
  },
}

const tokenSwapGw = {
  tokenSwap: {
    inputAmount: { amount: '20000', address: '0xabc', chain: 'ethereum' },
    outputAmount: { amount: '19500', address: '0xdef', chain: 'bob' },
    fees: { amount: '0', address: '0xabc', chain: 'ethereum' },
    slippage: 150,
    estimatedTimeInSecs: 120,
    priceImpact: '-0.0025',
  },
}

describe('toSwidgeQuote', () => {
  test('offramp: one fee line per breakdown entry, each in its own token', () => {
    expect(toSwidgeQuote(offrampGw, { affiliateApplied: true })).toEqual({
      fromTokenAmount: 100000n,
      toTokenAmount: 99000n,
      // 99000 × (1 − 50 bps)
      toTokenAmountMin: 98505n,
      fees: [
        {
          type: 'network',
          amount: 300n,
          token: '0xabc',
          chain: 'ethereum',
          included: true,
          description: 'Solver fee',
        },
        {
          type: 'network',
          amount: 200n,
          token: ZERO,
          chain: 'bitcoin',
          included: true,
          description: 'Bitcoin transaction inclusion fee',
        },
        {
          type: 'protocol',
          amount: 150n,
          token: '0xabc',
          chain: 'ethereum',
          included: true,
          description: 'Gateway protocol fee',
        },
        {
          type: 'affiliate',
          amount: 100n,
          token: '0xabc',
          chain: 'ethereum',
          included: true,
          description: 'Affiliate fee',
        },
      ],
      estimatedDuration: 600,
      priceImpact: -0.005,
      affiliateApplied: true,
    })
  })

  test('onramp: maps execution and LayerZero fees, string slippage, null priceImpact', () => {
    const q = toSwidgeQuote(onrampGw, { affiliateApplied: false })
    expect(q.toTokenAmountMin).toBe(47520n)
    expect(q.priceImpact).toBeUndefined()
    expect(q.affiliateApplied).toBe(false)
    expect(q.fees.map((f) => [f.type, f.amount, f.description])).toEqual([
      ['network', 500n, 'Solver fee'],
      ['network', 100n, 'Destination-chain execution fee'],
      ['network', 50n, 'LayerZero messaging fee'],
      ['protocol', 200n, 'Gateway protocol fee'],
      ['affiliate', 75n, 'Affiliate fee'],
    ])
  })

  test('tokenSwap: no fee breakdown → no fees', () => {
    const q = toSwidgeQuote(tokenSwapGw, { affiliateApplied: false })
    expect(q.fromTokenAmount).toBe(20000n)
    expect(q.toTokenAmount).toBe(19500n)
    expect(q.toTokenAmountMin).toBe(19207n)
    expect(q.estimatedDuration).toBe(120)
    expect(q.priceImpact).toBe(-0.0025)
    expect(q.fees).toEqual([])
  })

  test('toTokenAmountMin falls back to the estimate when the quote carries no slippage', () => {
    const offramp = { ...offrampGw.offramp, slippage: undefined }
    expect(toSwidgeQuote({ offramp }, { affiliateApplied: false }).toTokenAmountMin).toBe(99000n)
  })

  test('zero-amount fee entries are dropped', () => {
    const gw = {
      offramp: {
        ...offrampGw.offramp,
        feeBreakdown: {
          ...offrampGw.offramp.feeBreakdown,
          affiliateFee: { amount: '0', address: '0xabc', chain: 'ethereum' },
        },
      },
    }
    const q = toSwidgeQuote(gw, { affiliateApplied: false })
    expect(q.fees.map((f) => f.type)).toEqual(['network', 'network', 'protocol'])
  })
})

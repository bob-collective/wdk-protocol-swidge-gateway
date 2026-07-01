import { describe, test, expect } from 'vitest'
import { toSwidgeQuote } from '../src/map/quote.js'

// Real wire shape: camelCase, feeBreakdown, all amounts are strings
const offrampGw = {
  offramp: {
    inputAmount: { amount: '100000', address: '0xabc', chain: 'ethereum' },
    outputAmount: { amount: '99000', address: '0x0000000000000000000000000000000000000000', chain: 'bitcoin' },
    totalFeeUsd: '1.50',
    feeBreakdown: {
      solverFee: { amount: '300', address: '0xabc', chain: 'ethereum' },
      inclusionFee: { amount: '200', address: '0x0000000000000000000000000000000000000000', chain: 'bitcoin' },
      protocolFee: { amount: '150', address: '0xabc', chain: 'ethereum' },
      affiliateFee: { amount: '100', address: '0xabc', chain: 'ethereum' },
      fastestFeeRate: '10',
    },
    estimatedTimeInSecs: 600,
    priceImpact: '-0.0050',
  },
}

const onrampGw = {
  onramp: {
    inputAmount: { amount: '50000', address: '0x0000000000000000000000000000000000000000', chain: 'bitcoin' },
    outputAmount: { amount: '48000', address: '0xabc', chain: 'bob' },
    feeBreakdown: {
      solverFee: { amount: '500', address: '0xabc', chain: 'bob' },
      protocolFee: { amount: '200', address: '0xabc', chain: 'bob' },
      affiliateFee: { amount: '75', address: '0xabc', chain: 'bob' },
      executionFee: { amount: '100', address: '0xabc', chain: 'bob' },
      layerzeroFee: { amount: '50', address: '0xabc', chain: 'bob' },
    },
    estimatedTimeInSecs: 900,
    priceImpact: null,
  },
}

const tokenSwapGw = {
  tokenSwap: {
    inputAmount: { amount: '20000', address: '0xabc', chain: 'ethereum' },
    outputAmount: { amount: '19500', address: '0xdef', chain: 'bob' },
    fees: { amount: '0', address: '0xabc', chain: 'ethereum' },
    estimatedTimeInSecs: 120,
    priceImpact: '-0.0025',
  },
}

describe('toSwidgeQuote', () => {
  test('offramp: maps amounts and fees correctly', () => {
    const q = toSwidgeQuote(offrampGw, { affiliateApplied: true })
    expect(q.fromTokenAmount).toBe(100000n)
    expect(q.toTokenAmount).toBe(99000n)
    // no outputAmountMin on offramp — falls back to outputAmount
    expect(q.toTokenAmountMin).toBe(99000n)
    expect(q.estimatedDuration).toBe(600)
    expect(q.priceImpact).toBe('-0.0050')
    expect(q.affiliateApplied).toBe(true)
    // network = solverFee(300) + inclusionFee(200) = 500
    expect(q.fees).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'network', amount: 500n })]))
    expect(q.fees).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'protocol', amount: 150n })]))
    expect(q.fees).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'affiliate', amount: 100n })]))
  })

  test('onramp: maps amounts and fees, no inclusionFee so network = solverFee only', () => {
    const q = toSwidgeQuote(onrampGw, { affiliateApplied: false })
    expect(q.fromTokenAmount).toBe(50000n)
    expect(q.toTokenAmount).toBe(48000n)
    expect(q.estimatedDuration).toBe(900)
    expect(q.affiliateApplied).toBe(false)
    // network = solverFee(500) only (no inclusionFee on onramp)
    expect(q.fees).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'network', amount: 500n })]))
    expect(q.fees).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'protocol', amount: 200n })]))
    expect(q.fees).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'affiliate', amount: 75n })]))
  })

  test('tokenSwap: maps amounts, emits no fees when all zero', () => {
    const q = toSwidgeQuote(tokenSwapGw, { affiliateApplied: false })
    expect(q.fromTokenAmount).toBe(20000n)
    expect(q.toTokenAmount).toBe(19500n)
    expect(q.estimatedDuration).toBe(120)
    expect(q.fees).toHaveLength(0)
  })

  test('affiliateApplied false excludes affiliate when amount is zero', () => {
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
    const types = q.fees.map((f) => f.type)
    expect(types).not.toContain('affiliate')
  })
})

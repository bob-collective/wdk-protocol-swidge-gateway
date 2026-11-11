// Route discovery (getSupportedChains, getSupportedTokens) and order status (getSwidgeStatus).
import { beforeEach, describe, test, expect, vi } from 'vitest'
import { GatewaySwidge } from '../src/index.js'
import type { GatewayClient } from '../src/index.js'
import { USDT_BASE, ZERO, completedOrder } from './fixtures/gateway.js'
import { USDT as USDT_TRON } from './fixtures/tron.js'

const getRoutes = vi.fn()
const getOrder = vi.fn()
const client = { getRoutes, getOrder } as unknown as GatewayClient

const UNKNOWN_SOLANA_TOKEN = 'So11111111111111111111111111111111111111112'

/** get-routes: known and unknown chains, and a token missing from the token table. */
const ROUTES = [
  { srcChain: 'bitcoin', dstChain: 'base', srcToken: ZERO, dstToken: USDT_BASE },
  { srcChain: 'base', dstChain: 'bitcoin', srcToken: USDT_BASE, dstToken: ZERO },
  { srcChain: 'base', dstChain: 'solana', srcToken: USDT_BASE, dstToken: UNKNOWN_SOLANA_TOKEN },
  { srcChain: 'tron', dstChain: 'bitcoin', srcToken: USDT_TRON, dstToken: ZERO },
  { srcChain: 'bsc', dstChain: 'mystery', srcToken: ZERO, dstToken: ZERO },
]

const BTC_TOKEN = {
  token: ZERO,
  chain: 'bitcoin',
  address: ZERO,
  symbol: 'BTC',
  decimals: 8,
  name: 'Bitcoin',
}
const USDT_BASE_TOKEN = {
  token: USDT_BASE,
  chain: 'base',
  address: USDT_BASE,
  symbol: 'USDT',
  decimals: 6,
  name: 'Tether USD',
}

function gatewaySwidge() {
  return new GatewaySwidge(undefined, { fromChain: 'base', client })
}

beforeEach(() => {
  vi.resetAllMocks()
  getRoutes.mockResolvedValue(ROUTES)
})

describe('getSupportedChains', () => {
  test('names, VM types and native tokens come from the chain table', async () => {
    const chains = await gatewaySwidge().getSupportedChains()

    expect(getRoutes).toHaveBeenCalledWith()
    expect(chains).toEqual([
      { id: 'bitcoin', name: 'Bitcoin', type: 'utxo', nativeToken: 'BTC' },
      { id: 'base', name: 'Base', type: 'evm', nativeToken: 'ETH' },
      { id: 'solana', name: 'Solana', type: 'svm', nativeToken: 'SOL' },
      { id: 'tron', name: 'Tron', type: 'tvm', nativeToken: 'TRX' },
      { id: 'bsc', name: 'BNB Smart Chain', type: 'evm', nativeToken: 'BNB' },
      // Unknown chain: raw id as name, its family's VM type, native token not guessed.
      { id: 'mystery', name: 'mystery', type: 'evm', nativeToken: '' },
    ])
  })

  test('chain ids that collide with Object.prototype get no inherited metadata', async () => {
    getRoutes.mockResolvedValue([
      { srcChain: 'constructor', dstChain: 'toString', srcToken: ZERO, dstToken: ZERO },
    ])

    const chains = await gatewaySwidge().getSupportedChains()

    expect(chains).toEqual([
      { id: 'constructor', name: 'constructor', type: 'evm', nativeToken: '' },
      { id: 'toString', name: 'toString', type: 'evm', nativeToken: '' },
    ])
  })
})

describe('getSupportedTokens', () => {
  // A wrong decimals guess would mis-scale amounts, so a token missing from the table is left out.
  test('carries symbol, decimals and name from the token table, leaving out unknown tokens', async () => {
    const tokens = await gatewaySwidge().getSupportedTokens()

    expect(getRoutes).toHaveBeenCalledWith()
    expect(tokens).toEqual([
      BTC_TOKEN,
      USDT_BASE_TOKEN,
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

  test('fromChain keeps only that chain’s tokens', async () => {
    const tokens = await gatewaySwidge().getSupportedTokens({ fromChain: 'base' })

    expect(tokens).toEqual([USDT_BASE_TOKEN])
  })
})

describe('getSwidgeStatus', () => {
  const ORDER_ID = 'f87cce13-a0da-4c2c-b0cf-773802f94b7e'
  const SRC_INFO = { chain: 'bitcoin', token: ZERO, amount: '33624', txHash: 'd70f' }
  const SOURCE = { hash: 'd70f', chain: 'bitcoin', type: 'source' }
  const transfer = (txHash: string) => ({
    token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: '24901436',
    chain: 'ethereum',
    txHash,
  })

  test('a completed order reports its source and destination transactions', async () => {
    getOrder.mockResolvedValue(completedOrder())

    const status = await gatewaySwidge().getSwidgeStatus(ORDER_ID)

    expect(getOrder).toHaveBeenCalledWith(ORDER_ID)
    expect(status).toEqual({
      status: 'completed',
      transactions: [
        {
          hash: 'd70ffadb43a9118f94d82fcf6cf7d5a05c688f6ebed4500144e2ce732effad4d',
          chain: 'bitcoin',
          type: 'source',
        },
        {
          hash: '0xddfa5650b89a496aa672fae2b48e709982617daf3dc1090f48e28899c58876e5',
          chain: 'ethereum',
          type: 'destination',
        },
      ],
    })
  })

  test.each([
    [
      'refunded, with its refund transactions',
      { refunded: { refunded_tokens: [transfer('0xrefund')] } },
      {
        status: 'refunded',
        transactions: [SOURCE, { hash: '0xrefund', chain: 'ethereum', type: 'refund' }],
      },
    ],
    ['failed', { failed: { refund_tx: null } }, { status: 'failed', transactions: [SOURCE] }],
    [
      'refund-pending, failed with a refund under way',
      { failed: { refund_tx: { hash: '0x1' } } },
      { status: 'refund-pending', transactions: [SOURCE] },
    ],
    [
      'refund-pending, in progress with a refund under way',
      { inProgress: { refund_tx: { hash: '0x1' } } },
      { status: 'refund-pending', transactions: [SOURCE] },
    ],
    ['pending', { inProgress: {} }, { status: 'pending', transactions: [SOURCE] }],
  ])('maps an order that is %s', async (_label, status, expected) => {
    getOrder.mockResolvedValue({ id: ORDER_ID, timestamp: 0, srcInfo: SRC_INFO, status })

    const result = await gatewaySwidge().getSwidgeStatus(ORDER_ID)

    expect(result).toEqual(expected)
  })

  test.each([
    ['an unknown variant', { settling: {} }, 'settling'],
    ['no variant', {}, 'none'],
    ['no status object', null, 'none'],
  ])('refuses an order with %s instead of reading it as pending', async (_label, status, keys) => {
    getOrder.mockResolvedValue({ id: ORDER_ID, timestamp: 0, srcInfo: SRC_INFO, status })

    await expect(gatewaySwidge().getSwidgeStatus(ORDER_ID)).rejects.toMatchObject({
      name: 'GatewaySwidgeError',
      code: 'GATEWAY_HTTP_ERROR',
      message: `gateway order ${ORDER_ID} has an unknown status: ${keys}`,
      cause: status,
    })
  })

  test('a source transaction not yet indexed is left out', async () => {
    getOrder.mockResolvedValue({
      id: ORDER_ID,
      timestamp: 0,
      srcInfo: { ...SRC_INFO, txHash: null },
      status: { inProgress: {} },
    })

    const result = await gatewaySwidge().getSwidgeStatus(ORDER_ID)

    expect(result).toEqual({ status: 'pending', transactions: [] })
  })

  test('falls back to a legacy pending_btc_payment for the source transaction', async () => {
    getOrder.mockResolvedValue({
      id: ORDER_ID,
      timestamp: 0,
      status: { inProgress: { pending_btc_payment: { txid: 'abc', amount: '1' } } },
    })

    const result = await gatewaySwidge().getSwidgeStatus(ORDER_ID)

    expect(result).toEqual({
      status: 'pending',
      transactions: [{ hash: 'abc', chain: 'bitcoin', type: 'source' }],
    })
  })
})

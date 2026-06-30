/* eslint-env jest */
'use strict'

import { jest } from '@jest/globals'
import { GatewaySwidge } from '../src/gateway-swidge.js'

function fakeClient (overrides = {}) {
  return {
    getQuote: jest.fn(async () => ({ onramp: { inputAmount: { amount: '100000' }, outputAmount: { amount: '99000' }, fees: {} } })),
    createOrder: jest.fn(async () => ({ onramp: { orderId: 'o1', address: 'bc1q', inputAmount: { amount: '100000' } } })),
    registerTx: jest.fn(async () => ({})),
    getOrder: jest.fn(async () => ({ status: { Success: { received_tokens: [] } } })),
    getRoutes: jest.fn(async () => ([])),
    ...overrides
  }
}

test('swidge onramp: quote → createOrder → btc send → register → id', async () => {
  const account = { getAddress: async () => 'bc1q', signTransaction: async () => ({ toHex: () => 'hex', getId: () => 'btctxid' }) }
  const client = fakeClient()
  const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', client })
  const res = await sw.swidge({ fromToken: 'BTC', toToken: 'USDT', toChain: 'base', recipient: '0xrcpt', fromTokenAmount: 100000n })
  expect(client.createOrder).toHaveBeenCalled()
  expect(client.registerTx).toHaveBeenCalledWith({ onramp: { orderId: 'o1', bitcoinTxHex: 'hex' } })
  expect(res.id).toBe('o1')
  expect(res.hash).toBe('btctxid')
})

test('swidge onramp: registerTx failure does not throw', async () => {
  const account = { getAddress: async () => 'bc1q', signTransaction: async () => ({ toHex: () => 'hex', getId: () => 'txid2' }) }
  const client = fakeClient({ registerTx: jest.fn(async () => { throw new Error('network error') }) })
  const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', client })
  const res = await sw.swidge({ fromToken: 'BTC', toToken: 'USDT', toChain: 'base', recipient: '0xrcpt', fromTokenAmount: 100000n })
  expect(res.id).toBe('o1')
  expect(res.hash).toBe('txid2')
})

test('getSwidgeStatus maps order status', async () => {
  const sw = new GatewaySwidge({}, { fromChain: 'base', client: fakeClient() })
  expect((await sw.getSwidgeStatus('o1')).status).toBe('completed')
})

test('quoteSwidge returns mapped quote', async () => {
  const sw = new GatewaySwidge({ getAddress: async () => 'bc1q' }, { fromChain: 'bitcoin', client: fakeClient() })
  const q = await sw.quoteSwidge({ fromToken: 'BTC', toToken: 'USDT', toChain: 'base', recipient: '0xrcpt', fromTokenAmount: 100000n })
  expect(q.fromTokenAmount).toBe(100000n)
  expect(q.toTokenAmount).toBe(99000n)
})

test('getSupportedChains returns empty for empty routes', async () => {
  const sw = new GatewaySwidge({}, { fromChain: 'bitcoin', client: fakeClient() })
  expect(await sw.getSupportedChains()).toEqual([])
})

test('getSupportedTokens returns empty for empty routes', async () => {
  const sw = new GatewaySwidge({}, { fromChain: 'bitcoin', client: fakeClient() })
  expect(await sw.getSupportedTokens()).toEqual([])
})

test('_resolveChains throws when fromChain is missing', async () => {
  const sw = new GatewaySwidge({}, { client: fakeClient() })
  await expect(sw.quoteSwidge({ fromToken: 'BTC', toToken: 'USDT', toChain: 'base', fromTokenAmount: 100n }))
    .rejects.toThrow('source chain unknown')
})

test('swidge offramp: registers with srcTxHash and srcChain', async () => {
  const evmClient = fakeClient({
    getQuote: jest.fn(async () => ({ offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' } } })),
    createOrder: jest.fn(async () => ({ offramp: { orderId: 'o2', tx: { to: '0xto', data: '0xdata', value: '0' } } }))
  })
  const account = {
    getAddress: async () => '0xsender',
    sendTransaction: async () => ({ hash: '0xtxhash' })
  }
  const sw = new GatewaySwidge(account, { fromChain: 'base', client: evmClient })
  const res = await sw.swidge({ fromToken: '0xtok', toToken: 'BTC', toChain: 'bitcoin', recipient: 'bc1qrcpt', fromTokenAmount: 1000n })
  expect(evmClient.registerTx).toHaveBeenCalledWith({
    offramp: { orderId: 'o2', srcTxHash: '0xtxhash', srcChain: 'base' }
  })
  expect(res.id).toBe('o2')
  expect(res.hash).toBe('0xtxhash')
})

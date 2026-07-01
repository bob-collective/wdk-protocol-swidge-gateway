import { describe, test, expect, vi } from 'vitest'
import { GatewaySwidge } from '../src/gateway-swidge.js'
import type { GatewayClient } from '../src/gateway-client.js'

function fakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    getQuote: vi.fn(async () => ({
      onramp: { inputAmount: { amount: '100000' }, outputAmount: { amount: '99000' }, fees: {} },
    })),
    createOrder: vi.fn(async () => ({
      onramp: { orderId: 'o1', address: 'bc1q', inputAmount: { amount: '100000' } },
    })),
    registerTx: vi.fn(async () => ({})),
    getOrder: vi.fn(async () => ({ status: { Success: { received_tokens: [] } } })),
    getRoutes: vi.fn(async () => []),
    ...overrides,
  } as unknown as GatewayClient
}

describe('GatewaySwidge', () => {
  test('swidge onramp: quote → createOrder → btc send → register → id', async () => {
    const account = {
      getAddress: async () => 'bc1q',
      signTransaction: async () => ({ toHex: () => 'hex', getId: () => 'btctxid' }),
    }
    const client = fakeClient()
    const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', client })
    const res = await sw.swidge({
      fromToken: 'BTC',
      toToken: 'USDT',
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: 100000n,
    })
    expect(client.createOrder).toHaveBeenCalled()
    expect(client.registerTx).toHaveBeenCalledWith({ onramp: { orderId: 'o1', bitcoinTxHex: 'hex' } })
    expect(res.id).toBe('o1')
    expect(res.hash).toBe('btctxid')
  })

  test('swidge onramp: registerTx failure does not throw', async () => {
    const account = {
      getAddress: async () => 'bc1q',
      signTransaction: async () => ({ toHex: () => 'hex', getId: () => 'txid2' }),
    }
    const client = fakeClient({
      registerTx: vi.fn(async () => {
        throw new Error('network error')
      }) as unknown as GatewayClient['registerTx'],
    })
    const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', client })
    const res = await sw.swidge({
      fromToken: 'BTC',
      toToken: 'USDT',
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: 100000n,
    })
    expect(res.id).toBe('o1')
    expect(res.hash).toBe('txid2')
  })

  test('getSwidgeStatus maps order status', async () => {
    const sw = new GatewaySwidge({}, { fromChain: 'base', client: fakeClient() })
    expect((await sw.getSwidgeStatus('o1')).status).toBe('completed')
  })

  test('quoteSwidge returns mapped quote', async () => {
    const sw = new GatewaySwidge({ getAddress: async () => 'bc1q' }, { fromChain: 'bitcoin', client: fakeClient() })
    const q = await sw.quoteSwidge({
      fromToken: 'BTC',
      toToken: 'USDT',
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: 100000n,
    })
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
    await expect(
      sw.quoteSwidge({ fromToken: 'BTC', toToken: 'USDT', toChain: 'base', fromTokenAmount: 100n })
    ).rejects.toThrow('source chain unknown')
  })

  test('swidge offramp: registers with srcTxHash and quote srcChain (not caller fromChain)', async () => {
    // quote.offramp.srcChain = 'bob' overrides the caller's fromChain = 'base'
    const evmClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' }, srcChain: 'bob' },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: { orderId: 'o2', tx: { to: '0xto', data: '0xdata', value: '0' } },
      })) as unknown as GatewayClient['createOrder'],
    })
    const account = {
      getAddress: async () => '0xsender',
      sendTransaction: async () => ({ hash: '0xtxhash' }),
    }
    const sw = new GatewaySwidge(account, { fromChain: 'base', client: evmClient })
    const res = await sw.swidge({
      fromToken: '0xtok',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000n,
    })
    expect(evmClient.registerTx).toHaveBeenCalledWith({
      offramp: { orderId: 'o2', srcTxHash: '0xtxhash', srcChain: 'bob' },
    })
    expect(res.id).toBe('o2')
    expect(res.hash).toBe('0xtxhash')
  })

  test('swidge offramp: falls back to fromChain when quote has no srcChain', async () => {
    const evmClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' } },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: { orderId: 'o2b', tx: { to: '0xto', data: '0xdata', value: '0' } },
      })) as unknown as GatewayClient['createOrder'],
    })
    const account = {
      getAddress: async () => '0xsender',
      sendTransaction: async () => ({ hash: '0xtxhash2' }),
    }
    const sw = new GatewaySwidge(account, { fromChain: 'base', client: evmClient })
    await sw.swidge({
      fromToken: '0xtok',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000n,
    })
    expect(evmClient.registerTx).toHaveBeenCalledWith({
      offramp: { orderId: 'o2b', srcTxHash: '0xtxhash2', srcChain: 'base' },
    })
  })

  test('getRequiredApproval: caches spender per route — createOrder called at most once', async () => {
    const offrampClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' }, fees: {} },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: { orderId: 'o3', tx: { to: '0xspender', data: '0xdata', value: '0' } },
      })) as unknown as GatewayClient['createOrder'],
    })
    const account = {
      getAddress: async () => '0xsender',
      getAllowance: vi.fn(async () => 0n),
    }
    const sw = new GatewaySwidge(account, { fromChain: 'base', client: offrampClient })
    const options = {
      fromToken: '0xtok',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 500n,
    }

    const first = await sw.getRequiredApproval(options)
    const second = await sw.getRequiredApproval(options)

    expect(offrampClient.createOrder).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ token: '0xtok', spender: '0xspender', amount: 500n })
    expect(second).toEqual({ token: '0xtok', spender: '0xspender', amount: 500n })
  })

  test('getRequiredApproval: returns null for onramp routes without calling createOrder', async () => {
    const client = fakeClient()
    const account = { getAddress: async () => 'bc1q' }
    const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', client })
    const result = await sw.getRequiredApproval({
      fromToken: 'BTC',
      toToken: '0xtok',
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: 100000n,
    })
    expect(result).toBeNull()
    expect(client.createOrder).not.toHaveBeenCalled()
  })
})

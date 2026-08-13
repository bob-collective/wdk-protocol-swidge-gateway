import { describe, test, expect, vi } from 'vitest'
import { Transaction } from 'bitcoinjs-lib'
import { GatewaySwidge } from '../src/gateway-swidge.js'
import type { GatewayClient } from '../src/gateway-client.js'
import { buildTronTx, OWNER, REGISTRY } from './fixtures/tron.js'

const TRON_TXID = buildTronTx({ data: 'feed', feeLimit: 100_000_000 }).txID

function buildMinimalTxHex(): { hex: string; txid: string } {
  const tx = new Transaction()
  tx.addInput(Buffer.alloc(32, 0), 0)
  return { hex: tx.toHex(), txid: tx.getId() }
}

function fakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    getQuote: vi.fn(async () => ({
      onramp: { inputAmount: { amount: '100000' }, outputAmount: { amount: '99000' }, fees: {} },
    })),
    createOrder: vi.fn(async () => ({
      onramp: { order_id: 'o1', address: 'bc1q', inputAmount: { amount: '100000' } },
    })),
    registerTx: vi.fn(async () => ({})),
    getOrder: vi.fn(async () => ({ status: { success: { received_tokens: [] } } })),
    getRoutes: vi.fn(async () => []),
    ...overrides,
  } as unknown as GatewayClient
}

describe('GatewaySwidge', () => {
  test('swidge onramp: quote → createOrder → btc send → register → id', async () => {
    const { hex, txid } = buildMinimalTxHex()
    const account = {
      getAddress: async () => 'bc1q',
      signTransaction: async () => hex,
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
    expect(client.registerTx).toHaveBeenCalledWith({
      onramp: { order_id: 'o1', bitcoin_tx_hex: hex },
    })
    expect(res.id).toBe('o1')
    expect(res.hash).toBe(txid)
  })

  test('swidge onramp: registerTx failure does not throw', async () => {
    const { hex, txid } = buildMinimalTxHex()
    const account = {
      getAddress: async () => 'bc1q',
      signTransaction: async () => hex,
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
    expect(res.hash).toBe(txid)
  })

  test('getSwidgeStatus maps order status', async () => {
    const sw = new GatewaySwidge({}, { fromChain: 'base', client: fakeClient() })
    expect((await sw.getSwidgeStatus('o1')).status).toBe('completed')
  })

  test('quoteSwidge returns mapped quote', async () => {
    const sw = new GatewaySwidge(
      { getAddress: async () => 'bc1q' },
      { fromChain: 'bitcoin', client: fakeClient() }
    )
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
        offramp: {
          inputAmount: { amount: '1000' },
          outputAmount: { amount: '900' },
          srcChain: 'bob',
        },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: { order_id: 'o2', tx: { to: '0xto', data: '0xdata', value: '0' } },
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
      offramp: { order_id: 'o2', src_tx_hash: '0xtxhash', src_chain: 'bob' },
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
        offramp: { order_id: 'o2b', tx: { to: '0xto', data: '0xdata', value: '0' } },
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
      offramp: { order_id: 'o2b', src_tx_hash: '0xtxhash2', src_chain: 'base' },
    })
  })

  test('swidge offramp from tron: builds the contract call, registers with src_chain tron', async () => {
    const tronClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: {
          inputAmount: { amount: '1000000' },
          outputAmount: { amount: '900' },
          srcChain: 'tron',
        },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: {
          order_id: 'o-tron',
          tx: {
            type: 'tron',
            to: REGISTRY,
            data: '0xfeed',
            value: '0',
            chain: 'tron',
            feeLimit: '100000000',
          },
        },
      })) as unknown as GatewayClient['createOrder'],
    })
    const triggerSmartContract = vi.fn(
      async (
        to: string,
        _selector: string,
        options: { input: string; callValue: number; feeLimit: number },
        _parameters: unknown[],
        owner: string
      ) => ({
        transaction: buildTronTx({
          to,
          owner,
          data: options.input,
          callValue: options.callValue,
          feeLimit: options.feeLimit,
        }),
      })
    )
    const account = {
      getAddress: async () => OWNER,
      sendTransaction: vi.fn(async (tx: { txID: string }) => ({ hash: tx.txID })),
      _tronWeb: {
        transactionBuilder: { triggerSmartContract },
        trx: { getTransaction: vi.fn(async (txid: string) => ({ txID: txid })) },
      },
    }
    const sw = new GatewaySwidge(account, { fromChain: 'tron', client: tronClient })
    const res = await sw.swidge({
      fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000000n,
    })
    expect(triggerSmartContract).toHaveBeenCalledWith(
      REGISTRY,
      '',
      { input: 'feed', callValue: 0, feeLimit: 100_000_000 },
      [],
      OWNER
    )
    // The Tron txid goes on the wire bare — the gateway parses it with or without 0x.
    expect(tronClient.registerTx).toHaveBeenCalledWith({
      offramp: { order_id: 'o-tron', src_tx_hash: TRON_TXID, src_chain: 'tron' },
    })
    expect(res.id).toBe('o-tron')
    expect(res.hash).toBe(TRON_TXID)
  })

  test('swidge offramp from tron: config.tronConfirmTimeoutMs bounds the broadcast read-back', async () => {
    const tronClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: {
          inputAmount: { amount: '1000000' },
          outputAmount: { amount: '900' },
          srcChain: 'tron',
        },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: {
          order_id: 'o-tron',
          tx: { type: 'tron', to: REGISTRY, data: '0xfeed', value: '0', feeLimit: '100000000' },
        },
      })) as unknown as GatewayClient['createOrder'],
    })
    const getTransaction = vi.fn(async () => {
      throw new Error('Transaction not found')
    })
    const account = {
      getAddress: async () => OWNER,
      sendTransaction: vi.fn(async (tx: { txID: string }) => ({ hash: tx.txID })),
      _tronWeb: {
        transactionBuilder: {
          triggerSmartContract: vi.fn(
            async (
              to: string,
              _selector: string,
              options: { input: string; callValue: number; feeLimit: number },
              _parameters: unknown[],
              owner: string
            ) => ({
              transaction: buildTronTx({
                to,
                owner,
                data: options.input,
                callValue: options.callValue,
                feeLimit: options.feeLimit,
              }),
            })
          ),
        },
        trx: { getTransaction },
      },
    }
    const sw = new GatewaySwidge(account, {
      fromChain: 'tron',
      client: tronClient,
      tronConfirmTimeoutMs: 0,
    })
    await expect(
      sw.swidge({
        fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        toToken: 'BTC',
        toChain: 'bitcoin',
        recipient: 'bc1qrcpt',
        fromTokenAmount: 1000000n,
      })
    ).rejects.toThrow(
      new RegExp(`does not know transaction ${TRON_TXID} 0ms after broadcasting it`)
    )
    expect(getTransaction).toHaveBeenCalledTimes(1)
    expect(tronClient.registerTx).not.toHaveBeenCalled()
  })

  test.each([
    [
      'a tron route answered with an untyped (EVM) tx',
      'tron',
      undefined,
      /evm transaction for a tron route/,
    ],
    ['an evm route answered with a tron tx', 'base', 'tron', /tron transaction for a evm route/],
  ])('swidge rejects %s', async (_label, fromChain, txType, expected) => {
    const client = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: { inputAmount: { amount: '1000000' }, outputAmount: { amount: '900' } },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: {
          order_id: 'o-mixed',
          tx: { ...(txType ? { type: txType } : {}), to: REGISTRY, data: '0xfeed', value: '0' },
        },
      })) as unknown as GatewayClient['createOrder'],
    })
    const account = {
      getAddress: async () => OWNER,
      sendTransaction: vi.fn(async () => ({ hash: 'nope' })),
    }
    const sw = new GatewaySwidge(account, { fromChain, client })
    await expect(
      sw.swidge({
        fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        toToken: 'BTC',
        toChain: 'bitcoin',
        recipient: 'bc1qrcpt',
        fromTokenAmount: 1000000n,
      })
    ).rejects.toThrow(expected)
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('quoteSwidge from tron: ownerAddress is 0x-hex while sender stays Base58Check', async () => {
    const getQuote = vi.fn(async () => ({
      offramp: { inputAmount: { amount: '1000000' }, outputAmount: { amount: '900' } },
    }))
    const sw = new GatewaySwidge(
      { getAddress: async () => OWNER },
      { fromChain: 'tron', client: fakeClient({ getQuote } as unknown as Partial<GatewayClient>) }
    )
    await sw.quoteSwidge({
      fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000000n,
    })
    expect(getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: OWNER,
        ownerAddress: '0x891cdb91d149f23b1a45d9c5ca78a88d0cb44c18',
      })
    )
  })

  test('quoteSwidge onramp to tron: the Tron recipient becomes a 0x-hex ownerAddress', async () => {
    const getQuote = vi.fn(async () => ({
      onramp: { inputAmount: { amount: '100000' }, outputAmount: { amount: '99000' } },
    }))
    const sw = new GatewaySwidge(
      { getAddress: async () => 'bc1q' },
      {
        fromChain: 'bitcoin',
        client: fakeClient({ getQuote } as unknown as Partial<GatewayClient>),
      }
    )
    await sw.quoteSwidge({
      fromToken: 'BTC',
      toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toChain: 'tron',
      recipient: OWNER,
      fromTokenAmount: 100000n,
    })
    expect(getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: OWNER,
        ownerAddress: '0x891cdb91d149f23b1a45d9c5ca78a88d0cb44c18',
      })
    )
  })

  test('config.ownerAddress overrides the derived owner', async () => {
    const getQuote = vi.fn(async () => ({
      offramp: { inputAmount: { amount: '1000000' }, outputAmount: { amount: '900' } },
    }))
    const sw = new GatewaySwidge(
      { getAddress: async () => OWNER },
      {
        fromChain: 'tron',
        ownerAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        client: fakeClient({ getQuote } as unknown as Partial<GatewayClient>),
      }
    )
    await sw.quoteSwidge({
      fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000000n,
    })
    expect(getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: OWNER,
        ownerAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      })
    )
  })

  test('getRequiredApproval: tron routes read the allowance via the account provider', async () => {
    const tronClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: {
          inputAmount: { amount: '1000000' },
          outputAmount: { amount: '900' },
          srcChain: 'tron',
        },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: {
          order_id: 'o-tron2',
          tx: { type: 'tron', to: REGISTRY, data: '0xfeed', value: '0' },
        },
      })) as unknown as GatewayClient['createOrder'],
    })
    const triggerConstantContract = vi.fn(async () => ({ constant_result: ['0'.repeat(64)] }))
    const account = {
      getAddress: async () => OWNER,
      _tronWeb: { transactionBuilder: { triggerConstantContract } },
    }
    const sw = new GatewaySwidge(account, { fromChain: 'tron', client: tronClient })
    const out = await sw.getRequiredApproval({
      fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000000n,
    })
    expect(triggerConstantContract).toHaveBeenCalled()
    expect(out).toEqual({
      token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      spender: REGISTRY,
      amount: 1000000n,
    })
  })

  test('getRequiredApproval: caches spender per route — createOrder called at most once', async () => {
    const offrampClient = fakeClient({
      getQuote: vi.fn(async () => ({
        offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' }, fees: {} },
      })) as unknown as GatewayClient['getQuote'],
      createOrder: vi.fn(async () => ({
        offramp: { order_id: 'o3', tx: { to: '0xspender', data: '0xdata', value: '0' } },
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

// Attribution is revenue-bearing: gateway-wdk volume is credited to BOB (at 0 fee) purely by
// this token riding on every request. Dropping the default would keep every other test green
// while silently un-attributing all WDK volume, so pin the exact value that goes on the wire.
describe('GatewaySwidge attribution', () => {
  const BOB_BEARER_TOKEN = '49e52108b436492ebf03e85aa914718b'

  const httpSpy = () => ({
    request: vi.fn(async () => ({
      status: 200,
      body: { onramp: { inputAmount: { amount: '1' }, outputAmount: { amount: '1' }, fees: {} } },
    })),
  })

  const quote = (sw: GatewaySwidge) =>
    sw.quoteSwidge({
      fromToken: 'BTC',
      toToken: '0xtok',
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: 100000n,
    })

  test('with no bearerToken configured, requests carry BOB’s attribution key', async () => {
    const http = httpSpy()
    await quote(new GatewaySwidge({}, { fromChain: 'bitcoin', http }))
    expect(http.request).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/v3/get-quote'),
      expect.objectContaining({
        headers: { authorization: `Bearer ${BOB_BEARER_TOKEN}` },
      })
    )
  })

  test('an explicit bearerToken overrides the default (direct API agreements)', async () => {
    const http = httpSpy()
    await quote(new GatewaySwidge({}, { fromChain: 'bitcoin', bearerToken: 'x'.repeat(32), http }))
    expect(http.request).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/v3/get-quote'),
      expect.objectContaining({
        headers: { authorization: 'Bearer ' + 'x'.repeat(32) },
      })
    )
  })
})

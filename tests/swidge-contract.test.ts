// WDK SwidgeProtocol contract, exercised through GatewaySwidge's public API.
import { describe, test, expect, vi } from 'vitest'
import {
  AccountRequiredError,
  MaximumFeeExceededError,
  SwapError,
  SwidgeError,
  SwidgeErrorReason,
  ValueError,
} from '@tetherto/wdk-wallet/protocols'
import { GatewaySwidge } from '../src/gateway-swidge.js'
import type { GatewaySwidgeConfig } from '../src/gateway-swidge.js'
import type { GatewayClient } from '../src/gateway-client.js'
import {
  USDC_BASE,
  USDT_BASE,
  USDT0_ARBITRUM,
  USDT_ETHEREUM,
  ZERO,
  completedOrder,
  offrampOrder,
  offrampQuote,
  tokenSwapOrder,
  tokenSwapQuote,
} from './fixtures/gateway.js'

type Quote = ReturnType<typeof offrampQuote> | ReturnType<typeof tokenSwapQuote>

function fakeClient(quote: Quote = offrampQuote(), order: unknown = offrampOrder()) {
  return {
    getQuote: vi.fn(async () => quote),
    createOrder: vi.fn(async () => order),
    registerTx: vi.fn(),
    getOrder: vi.fn(async () => completedOrder()),
    getRoutes: vi.fn(async () => [
      { srcChain: 'bitcoin', dstChain: 'base', srcToken: ZERO, dstToken: USDT_BASE },
      { srcChain: 'base', dstChain: 'bitcoin', srcToken: USDT_BASE, dstToken: ZERO },
      { srcChain: 'base', dstChain: 'robinhood', srcToken: USDT_BASE, dstToken: '0xnew' },
    ]),
  }
}

function evmAccount() {
  return {
    getAddress: vi.fn(async () => '0xsender'),
    sendTransaction: vi.fn(async () => ({ hash: '0xtxhash' })),
  }
}

function setup(
  opts: {
    quote?: Quote
    order?: unknown
    account?: unknown
    config?: GatewaySwidgeConfig
  } = {}
) {
  const client = fakeClient(opts.quote, opts.order)
  const account = 'account' in opts ? opts.account : evmAccount()
  const sw = new GatewaySwidge(account, {
    fromChain: 'base',
    client: client as unknown as GatewayClient,
    ...opts.config,
  })
  return { sw, client, account }
}

/** Base USDT → BTC, without an amount. */
const ROUTE = { fromToken: USDT_BASE, toToken: 'BTC', toChain: 'bitcoin', recipient: 'bc1qrcpt' }
const OFFRAMP = { ...ROUTE, fromTokenAmount: 100_000_000n }

describe('swidge(): result', () => {
  test('returns the order id, source tx, per-token fees and the slippage floor', async () => {
    const { sw } = setup()
    expect(await sw.swidge(OFFRAMP)).toEqual({
      id: 'order-offramp',
      hash: '0xtxhash',
      fees: [
        {
          type: 'network',
          amount: 995n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Solver fee',
        },
        {
          type: 'network',
          amount: 880n,
          token: ZERO,
          chain: 'bitcoin',
          included: true,
          description: 'Bitcoin transaction inclusion fee',
        },
      ],
      transactions: [{ hash: '0xtxhash', chain: 'base', type: 'source' }],
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 133_315n,
      // 133315 × (1 − 50 bps)
      toTokenAmountMin: 132_648n,
    })
  })
})

describe('exact-out', () => {
  test('toTokenAmount is rejected before any gateway call', async () => {
    const { sw, client } = setup()
    const err = await sw.swidge({ ...ROUTE, toTokenAmount: 133_315n }).catch((e) => e)
    expect(err).toBeInstanceOf(ValueError)
    expect(err.message).toBe(
      'exact-out swidges (toTokenAmount) are not supported by the BOB Gateway: pass fromTokenAmount'
    )
    expect(client.getQuote).not.toHaveBeenCalled()
  })

  test('quoteSwidge rejects toTokenAmount too', async () => {
    const { sw } = setup()
    await expect(sw.quoteSwidge({ ...ROUTE, toTokenAmount: 1n })).rejects.toBeInstanceOf(ValueError)
  })

  test('a missing fromTokenAmount is rejected instead of quoting amount=0', async () => {
    const { sw, client } = setup()
    // @ts-expect-error: neither amount given
    await expect(sw.quoteSwidge(ROUTE)).rejects.toThrow(
      new ValueError('fromTokenAmount is required')
    )
    expect(client.getQuote).not.toHaveBeenCalled()
  })
})

describe('minAmountOut', () => {
  test('a slippage floor below minAmountOut refuses before create-order', async () => {
    const { sw, client, account } = setup()
    const err = await sw.swidge({ ...OFFRAMP, minAmountOut: 132_649n }).catch((e) => e)
    expect(err).toBeInstanceOf(SwidgeError)
    expect(err.reason).toBe(SwidgeErrorReason.COULD_NOT_MET_THRESHOLD)
    expect(err.message).toBe(
      'quote guarantees at least 132648 of the destination token after slippage, below ' +
        'minAmountOut 132649'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
    expect((account as ReturnType<typeof evmAccount>).sendTransaction).not.toHaveBeenCalled()
  })

  test('a floor exactly at minAmountOut proceeds', async () => {
    const { sw, client } = setup()
    const res = await sw.swidge({ ...OFFRAMP, minAmountOut: 132_648 })
    expect(res.id).toBe('order-offramp')
    expect(client.createOrder).toHaveBeenCalledTimes(1)
  })

  test('simulateSwidge applies it too', async () => {
    const { sw, client } = setup()
    await expect(sw.simulateSwidge({ ...OFFRAMP, minAmountOut: 200_000n })).rejects.toBeInstanceOf(
      SwidgeError
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('swap() forwards it and surfaces the refusal as a SwapError', async () => {
    const { sw } = setup({ quote: tokenSwapQuote('base', 'base'), order: tokenSwapOrder() })
    const err = await sw
      .swap({
        tokenIn: USDT_BASE,
        tokenOut: USDC_BASE,
        tokenInAmount: 100_000_000n,
        minAmountOut: 99_000_000n,
      })
      .catch((e) => e)
    expect(err).toBeInstanceOf(SwapError)
    expect(err.reason).toBe(SwidgeErrorReason.COULD_NOT_MET_THRESHOLD)
  })

  test('a non-integer minAmountOut is a ValueError', async () => {
    const { sw } = setup()
    await expect(sw.swidge({ ...OFFRAMP, minAmountOut: 1.5 })).rejects.toThrow(
      new ValueError('minAmountOut must be a non-negative integer amount in base units, got 1.5')
    )
  })

  test('a quote without its slippage echo is refused: the estimate is not a floor', async () => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    delete quote.offramp.slippage
    const { sw, client } = setup({ quote: quote as never })
    await expect(sw.swidge({ ...OFFRAMP, minAmountOut: 1n })).rejects.toThrow(
      'cannot verify minAmountOut: the quote carries no slippage to derive its minimum from'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })
})

describe('fee caps', () => {
  // Live quote: network fees $0 + $0.65 on a $99.82 input = 65.1 bps; no protocol fee.
  test('maxNetworkFeeBps below the quote refuses before create-order', async () => {
    const { sw, client } = setup({ config: { maxNetworkFeeBps: 50 } })
    const err = await sw.swidge(OFFRAMP).catch((e) => e)
    expect(err).toBeInstanceOf(MaximumFeeExceededError)
    expect(err.message).toBe(
      'network fee of 65.1 bps ($0.65 on $99.82) exceeds maxNetworkFeeBps (50)'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('maxNetworkFeeBps above the quote proceeds', async () => {
    const { sw, client } = setup({ config: { maxNetworkFeeBps: 70n } })
    await sw.swidge(OFFRAMP)
    expect(client.createOrder).toHaveBeenCalledTimes(1)
  })

  test('a per-call cap overrides the instance cap', async () => {
    const { sw } = setup({ config: { maxNetworkFeeBps: 1000 } })
    await expect(sw.swidge(OFFRAMP, { maxNetworkFeeBps: 10 })).rejects.toBeInstanceOf(
      MaximumFeeExceededError
    )
  })

  test('maxProtocolFeeBps refuses a protocol fee over the cap', async () => {
    const quote = offrampQuote()
    quote.offramp.feeBreakdown.protocolFee = {
      amount: '2000000',
      address: USDT_ETHEREUM,
      chain: 'ethereum',
      usd: '2.00',
    }
    const { sw, client } = setup({ quote, config: { maxProtocolFeeBps: 50 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'protocol fee of 200.4 bps ($2 on $99.82) exceeds maxProtocolFeeBps (50)',
        {}
      )
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('fails closed when a capped fee has no USD price', async () => {
    const quote = offrampQuote()
    quote.offramp.feeBreakdown.inclusionFee.usd = null as unknown as string
    const { sw, client } = setup({ quote, config: { maxNetworkFeeBps: 10_000 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'cannot verify maxNetworkFeeBps: the quote has no USD price for the bitcoin transaction ' +
          'inclusion fee',
        {}
      )
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('fails closed when the input has no USD price', async () => {
    const quote = offrampQuote()
    quote.offramp.inputAmount.usd = null as unknown as string
    const { sw } = setup({ quote, config: { maxNetworkFeeBps: 10_000 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'cannot verify maxNetworkFeeBps: the quote has no USD price for the input amount'
    )
  })

  test('without caps, missing USD prices are not checked', async () => {
    const quote = offrampQuote()
    quote.offramp.inputAmount.usd = null as unknown as string
    const { sw } = setup({ quote })
    await expect(sw.swidge(OFFRAMP)).resolves.toMatchObject({ id: 'order-offramp' })
  })

  test('a fee under an unknown breakdown key is reported as `other` and counts as network', async () => {
    const quote = offrampQuote()
    Object.assign(quote.offramp.feeBreakdown, {
      bridgeFee: { amount: '500000', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0.50' },
    })
    const { sw, client } = setup({ quote, config: { maxNetworkFeeBps: 100 } })
    // ($0.65 + $0.50) / $99.82 = 115.2 bps
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'network fee of 115.2 bps ($1.15 on $99.82) exceeds maxNetworkFeeBps (100)'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
    const q = await setup({ quote }).sw.quoteSwidge(OFFRAMP)
    expect(q.fees.at(-1)).toEqual({
      type: 'other',
      amount: 500_000n,
      token: USDT_ETHEREUM,
      chain: 'ethereum',
      included: true,
      description: 'bridgeFee',
    })
  })

  test('a cap that is not a finite, non-negative number is a ValueError, not a silent pass', async () => {
    const { sw, client } = setup({ config: { maxNetworkFeeBps: Number.NaN } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new ValueError('maxNetworkFeeBps must be a finite, non-negative number of bps, got NaN')
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('simulateSwidge takes per-call caps too', async () => {
    const { sw, client } = setup()
    await expect(sw.simulateSwidge(OFFRAMP, { maxNetworkFeeBps: 10 })).rejects.toBeInstanceOf(
      MaximumFeeExceededError
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('token swaps report no fees, so caps pass — bound them with minAmountOut', async () => {
    const { sw, client } = setup({
      quote: tokenSwapQuote(),
      order: tokenSwapOrder(),
      config: { maxNetworkFeeBps: 0, maxProtocolFeeBps: 0 },
    })
    await sw.swidge({ ...OFFRAMP, toToken: USDT0_ARBITRUM, toChain: 'arbitrum', recipient: '0xr' })
    expect(client.createOrder).toHaveBeenCalledTimes(1)
  })
})

describe('read-only accounts', () => {
  test('an EVM account without sendTransaction is refused before any gateway call', async () => {
    const { sw, client } = setup({ account: { getAddress: async () => '0xsender' } })
    const err = await sw.swidge(OFFRAMP).catch((e) => e)
    expect(err).toBeInstanceOf(AccountRequiredError)
    expect(err.message).toBe(
      'swidge() needs a full account that implements sendTransaction(); a read-only account can only quote'
    )
    expect(client.getQuote).not.toHaveBeenCalled()
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a Bitcoin account without signTransaction is refused', async () => {
    const { sw, client } = setup({
      account: { getAddress: async () => 'bc1q', sendTransaction: vi.fn() },
      config: { fromChain: 'bitcoin' },
    })
    await expect(
      sw.swidge({
        ...OFFRAMP,
        fromToken: 'BTC',
        toToken: USDT_BASE,
        toChain: 'base',
        recipient: '0xr',
      })
    ).rejects.toThrow(
      new AccountRequiredError(
        'swidge() needs a full account that implements signTransaction(); a read-only account can only quote'
      )
    )
    expect(client.getQuote).not.toHaveBeenCalled()
  })

  test('no account at all is refused', async () => {
    const { sw } = setup({ account: undefined })
    await expect(sw.swidge(OFFRAMP)).rejects.toBeInstanceOf(AccountRequiredError)
  })

  test('a read-only account can still quote', async () => {
    const { sw } = setup({ account: { getAddress: async () => '0xsender' } })
    await expect(sw.quoteSwidge(OFFRAMP)).resolves.toMatchObject({ toTokenAmount: 133_315n })
  })
})

describe('recipient', () => {
  test('a same-chain swap() without `to` pays out to the sender', async () => {
    const { sw, client } = setup({
      quote: tokenSwapQuote('base', 'base'),
      order: tokenSwapOrder(),
    })
    const res = await sw.swap({
      tokenIn: USDT_BASE,
      tokenOut: USDC_BASE,
      tokenInAmount: 1_000_000n,
    })
    expect(client.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({ srcChain: 'base', dstChain: 'base', recipient: '0xsender' })
    )
    expect(res).toEqual({
      hash: 'order-swap',
      fee: 0n,
      tokenInAmount: 100_000_000n,
      tokenOutAmount: 99_797_888n,
    })
  })

  test('a cross-chain route without a recipient is refused before quoting', async () => {
    const { sw, client } = setup()
    await expect(sw.quoteSwidge({ ...OFFRAMP, recipient: undefined })).rejects.toThrow(
      new ValueError('recipient is required for cross-chain routes (base → bitcoin)')
    )
    expect(client.getQuote).not.toHaveBeenCalled()
  })
})

describe('chain ids', () => {
  test('a numeric toChain (WDK types it string | number) is sent as a string', async () => {
    const { sw, client } = setup({ quote: tokenSwapQuote('base', '8453'), order: tokenSwapOrder() })
    await sw.quoteSwidge({ ...OFFRAMP, toToken: USDT0_ARBITRUM, toChain: 8453, recipient: '0xr' })
    expect(client.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({ srcChain: 'base', dstChain: '8453' })
    )
  })

  test('chain ids that collide with Object.prototype get no inherited metadata', async () => {
    const { sw, client } = setup()
    client.getRoutes.mockResolvedValueOnce([
      { srcChain: 'constructor', dstChain: 'toString', srcToken: ZERO, dstToken: ZERO },
    ])
    expect(await sw.getSupportedChains()).toEqual([
      { id: 'constructor', name: 'constructor', type: 'evm', nativeToken: '' },
      { id: 'toString', name: 'toString', type: 'evm', nativeToken: '' },
    ])
  })
})

describe('bridge()', () => {
  test('bridges via swidge and splits network vs protocol fees', async () => {
    const { sw, client } = setup({ quote: tokenSwapQuote(), order: tokenSwapOrder() })
    const res = await sw.bridge({
      token: USDT_BASE,
      targetChain: 'arbitrum',
      recipient: '0xrcpt',
      amount: 100_000_000n,
    })
    expect(client.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        srcChain: 'base',
        dstChain: 'arbitrum',
        srcToken: USDT_BASE,
        recipient: '0xrcpt',
        amount: '100000000',
      })
    )
    expect(res).toEqual({ hash: 'order-swap', fee: 0n, bridgeFee: 0n })
  })

  test('quoteBridge without a recipient is a ValueError, not a gateway 400', async () => {
    const { sw } = setup({ quote: tokenSwapQuote(), order: tokenSwapOrder() })
    await expect(
      sw.quoteBridge({ token: USDT_BASE, targetChain: 'arbitrum', amount: 1n } as never)
    ).rejects.toBeInstanceOf(ValueError)
  })
})

describe('quoteSwidge()', () => {
  test('maps the live quote to SwidgeQuote', async () => {
    const { sw } = setup({ quote: tokenSwapQuote(), order: tokenSwapOrder() })
    expect(
      await sw.quoteSwidge({
        fromToken: USDT_BASE,
        toToken: USDT0_ARBITRUM,
        toChain: 'arbitrum',
        recipient: '0xrcpt',
        fromTokenAmount: 100_000_000n,
      })
    ).toEqual({
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 99_797_888n,
      toTokenAmountMin: 98_300_919n,
      fees: [],
      estimatedDuration: 11,
      priceImpact: -0.002,
      affiliateApplied: false,
    })
  })
})

describe('discovery and status', () => {
  test('getSupportedChains names chains and their native tokens', async () => {
    const { sw } = setup()
    expect(await sw.getSupportedChains()).toEqual([
      { id: 'bitcoin', name: 'Bitcoin', type: 'utxo', nativeToken: 'BTC' },
      { id: 'base', name: 'Base', type: 'evm', nativeToken: 'ETH' },
      { id: 'robinhood', name: 'Robinhood Chain', type: 'evm', nativeToken: 'ETH' },
    ])
  })

  test('getSupportedTokens carries symbol and decimals, omitting unknown tokens', async () => {
    const { sw } = setup()
    expect(await sw.getSupportedTokens()).toEqual([
      { token: ZERO, chain: 'bitcoin', address: ZERO, symbol: 'BTC', decimals: 8, name: 'Bitcoin' },
      {
        token: USDT_BASE,
        chain: 'base',
        address: USDT_BASE,
        symbol: 'USDT',
        decimals: 6,
        name: 'Tether USD',
      },
    ])
  })

  test('getSwidgeStatus reports source and destination tx hashes', async () => {
    const { sw } = setup()
    expect(await sw.getSwidgeStatus('f87cce13-a0da-4c2c-b0cf-773802f94b7e')).toEqual({
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
})

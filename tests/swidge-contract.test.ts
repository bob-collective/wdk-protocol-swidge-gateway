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

type Quote = Partial<ReturnType<typeof offrampQuote> & ReturnType<typeof tokenSwapQuote>>

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
/** Base USDT → Base USDC, paid out to the sender. */
const SAME_CHAIN_SWAP = () =>
  tokenSwapQuote('base', 'base', { dstToken: USDC_BASE, recipient: '0xsender' })

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

  test('a non-integer fromTokenAmount is a ValueError, not a gateway 400', async () => {
    const { sw, client } = setup()
    await expect(sw.quoteSwidge({ ...ROUTE, fromTokenAmount: 1.5 })).rejects.toThrow(
      new ValueError('fromTokenAmount must be a non-negative integer amount in base units, got 1.5')
    )
    expect(client.getQuote).not.toHaveBeenCalled()
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
    const { sw } = setup({ quote: SAME_CHAIN_SWAP(), order: tokenSwapOrder() })
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

  test('an empty-string minAmountOut is a ValueError, not a zero floor', async () => {
    const { sw, client } = setup()
    await expect(sw.swidge({ ...OFFRAMP, minAmountOut: '' })).rejects.toThrow(
      new ValueError('minAmountOut must be a non-negative integer amount in base units, got ')
    )
    expect(client.getQuote).not.toHaveBeenCalled()
  })

  test.each([undefined, ''])(
    'a quote whose slippage echo is %j is refused: the estimate is not a floor',
    async (slippage) => {
      const quote = offrampQuote() as { offramp: Record<string, unknown> }
      quote.offramp.slippage = slippage
      const { sw, client } = setup({ quote: quote as never })
      await expect(sw.swidge({ ...OFFRAMP, minAmountOut: 1n })).rejects.toThrow(
        'cannot verify minAmountOut: the quote carries no slippage to derive its minimum from'
      )
      expect(client.createOrder).not.toHaveBeenCalled()
    }
  )
})

describe('quote binding', () => {
  // create-order posts the quote verbatim, so a quote for anything other than the request must
  // be refused before an order exists — minAmountOut and the fee caps only compare it to itself.
  test.each([
    [
      'input amount',
      (q: Quote) => (q.offramp!.inputAmount.amount = '1000000000'),
      '1000000000',
      '100000000',
    ],
    [
      'recipient',
      (q: Quote) => (q.offramp!.recipient = 'bc1qattacker'),
      'bc1qattacker',
      'bc1qrcpt',
    ],
    ['refundAddress', (q: Quote) => (q.offramp!.refundAddress = '0xother'), '0xother', '0xsender'],
    [
      'source token',
      (q: Quote) => (q.offramp!.inputAmount.address = USDC_BASE),
      USDC_BASE,
      USDT_BASE,
    ],
    [
      'destination token',
      (q: Quote) => (q.offramp!.outputAmount.address = USDT_BASE),
      USDT_BASE,
      ZERO,
    ],
    ['source chain', (q: Quote) => (q.offramp!.inputAmount.chain = 'ethereum'), 'ethereum', 'base'],
    ['source chain', (q: Quote) => (q.offramp!.srcChain = 'bob'), 'bob', 'base'],
    [
      'destination chain',
      (q: Quote) => (q.offramp!.outputAmount.chain = 'ethereum'),
      'ethereum',
      'bitcoin',
    ],
    [
      'destination chain',
      (q: Quote) => delete (q.offramp as { outputAmount: { chain?: string } }).outputAmount.chain,
      'undefined',
      'bitcoin',
    ],
  ] as const)(
    'a quote with another %s is refused before create-order',
    async (field, mutate, got, want) => {
      const quote = offrampQuote() as Quote
      mutate(quote)
      const { sw, client, account } = setup({ quote })
      await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
        `quote ${field} ${got} does not match the requested ${want}`
      )
      expect(client.createOrder).not.toHaveBeenCalled()
      expect((account as ReturnType<typeof evmAccount>).sendTransaction).not.toHaveBeenCalled()
    }
  )

  test('echoed addresses compare case-insensitively (the gateway checksums EVM addresses)', async () => {
    const { sw, client } = setup()
    await sw.swidge({ ...OFFRAMP, fromToken: USDT_BASE.toLowerCase() })
    expect(client.createOrder).toHaveBeenCalledTimes(1)
  })

  test('the right token on another destination chain is refused', async () => {
    // USDT0 has one address on many chains, so the token echo alone cannot tell them apart.
    const { sw, client } = setup({
      quote: tokenSwapQuote('base', 'arbitrum'),
      order: tokenSwapOrder(),
    })
    await expect(
      sw.swidge({
        fromToken: USDT_BASE,
        toToken: USDT0_ARBITRUM,
        toChain: 'ethereum',
        recipient: '0xrcpt',
        fromTokenAmount: 100_000_000n,
      })
    ).rejects.toThrow('quote destination chain arbitrum does not match the requested ethereum')
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a top-level dstChain echo is checked alongside the output amount chain', async () => {
    const quote = tokenSwapQuote('base', 'arbitrum')
    quote.tokenSwap.dstChain = 'ethereum'
    const { sw, client } = setup({ quote, order: tokenSwapOrder() })
    await expect(
      sw.swidge({
        fromToken: USDT_BASE,
        toToken: USDT0_ARBITRUM,
        toChain: 'arbitrum',
        recipient: '0xrcpt',
        fromTokenAmount: 100_000_000n,
      })
    ).rejects.toThrow('quote destination chain ethereum does not match the requested arbitrum')
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('chains compare case-insensitively, and both spellings of HyperEVM match', async () => {
    const quote = tokenSwapQuote('Base', 'hyperliquid')
    const { sw, client } = setup({ quote, order: tokenSwapOrder() })
    await sw.swidge({
      fromToken: USDT_BASE,
      toToken: USDT0_ARBITRUM,
      toChain: 'hyperevm',
      recipient: '0xrcpt',
      fromTokenAmount: 100_000_000n,
    })
    expect(client.createOrder).toHaveBeenCalledTimes(1)
  })
})

describe('slippage binding', () => {
  test('a quote echoing a looser slippage than requested is refused before create-order', async () => {
    const { sw, client } = setup()
    await expect(sw.swidge({ ...OFFRAMP, slippage: 0.003 })).rejects.toThrow(
      'quote slippage 50 is looser than the requested 30 bps'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('the configured default slippage is bound too', async () => {
    const { sw, client } = setup({ config: { slippage: 0.003 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow('looser than the requested 30 bps')
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a requested slippage the quote does not echo is refused', async () => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    delete quote.offramp.slippage
    const { sw, client } = setup({ quote: quote as never })
    await expect(sw.swidge({ ...OFFRAMP, slippage: 0.005 })).rejects.toThrow(
      'quote slippage undefined is looser than the requested 50 bps'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('an echo at or under the requested slippage proceeds', async () => {
    const { sw, client } = setup()
    await sw.swidge({ ...OFFRAMP, slippage: 0.005 })
    await sw.swidge({ ...OFFRAMP, slippage: 0.01 })
    expect(client.createOrder).toHaveBeenCalledTimes(2)
  })
})

describe('affiliate binding', () => {
  const fee = (amount: string) => ({
    amount,
    address: USDT_ETHEREUM,
    chain: 'ethereum',
    usd: '0.1',
  })
  const withAffiliates = (fields: Record<string, unknown>, affiliateFee = '0') => {
    const quote = offrampQuote()
    Object.assign(quote.offramp, fields)
    quote.offramp.feeBreakdown.affiliateFee = fee(affiliateFee)
    return quote as never
  }

  test.each([
    ['an affiliates[] entry', { affiliates: [{ address: '0xevil', fee: fee('500') }] }, '500'],
    ['affiliateAddress', { affiliateAddress: '0xevil' }, '0'],
    ['an entry with no address', { affiliates: [{ fee: fee('500') }] }, '500'],
  ])('with no affiliates configured, a quote paying %s is refused', async (_, fields, amount) => {
    const { sw, client } = setup({ quote: withAffiliates(fields, amount) })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(/quote pays affiliate .*, which the request/)
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('with no affiliates configured, an affiliate fee is refused even with no recipient', async () => {
    const { sw, client } = setup({ quote: withAffiliates({}, '1000') })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'quote charges an affiliate fee of 1000, but the request included no affiliates'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a token swap echoing an affiliate is refused (none is ever sent on token swaps)', async () => {
    const quote = SAME_CHAIN_SWAP()
    Object.assign(quote.tokenSwap, { affiliate: { address: '0xevil', bps: 100 } })
    const { sw, client } = setup({
      quote,
      order: tokenSwapOrder(),
      config: { affiliates: [{ address: '0xevil', bps: 100 }] },
    })
    await expect(
      sw.swap({ tokenIn: USDT_BASE, tokenOut: USDC_BASE, tokenInAmount: 100_000_000n })
    ).rejects.toThrow('quote pays affiliate 0xevil, which the request did not include')
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('configured affiliates are bound: an extra recipient is refused', async () => {
    const quote = withAffiliates(
      {
        affiliates: [
          { address: '0xBob', fee: fee('500') },
          { address: '0xevil', fee: fee('500') },
        ],
        affiliateAddress: '0xBob',
      },
      '1000'
    )
    const { sw, client } = setup({ quote, config: { affiliates: [{ address: '0xbob', bps: 10 }] } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'quote pays affiliate 0xevil, which the request did not include'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('configured affiliates echoed back (any case) proceed', async () => {
    const quote = withAffiliates(
      { affiliates: [{ address: '0xBob', fee: fee('500') }], affiliateAddress: '0xBOB' },
      '500'
    )
    const { sw, client } = setup({ quote, config: { affiliates: [{ address: '0xbob', bps: 10 }] } })
    await sw.swidge(OFFRAMP)
    expect(client.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({ affiliates: '0xbob:10' })
    )
    expect(client.createOrder).toHaveBeenCalledTimes(1)
  })

  test('a quote carrying another variant, or two, is refused', async () => {
    const both = { ...offrampQuote(), ...tokenSwapQuote() } as unknown as Quote
    const { sw, client } = setup({ quote: both })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'expected a offramp quote, got offramp + tokenSwap'
    )
    await expect(setup({ quote: tokenSwapQuote() }).sw.swidge(OFFRAMP)).rejects.toThrow(
      'expected a offramp quote, got tokenSwap'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a malformed fee amount throws before anything is broadcast', async () => {
    const quote = offrampQuote()
    quote.offramp.feeBreakdown.solverFee.amount = '9.95'
    const { sw, account } = setup({ quote })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow()
    expect((account as ReturnType<typeof evmAccount>).sendTransaction).not.toHaveBeenCalled()
  })
})

describe("the 'BTC' alias", () => {
  // 'BTC' maps to the zero address, which on an EVM chain is its gas token.
  test('as toToken without toChain is refused, not swapped into the source chain gas token', async () => {
    const { sw, client } = setup()
    await expect(sw.swidge({ ...OFFRAMP, toChain: undefined })).rejects.toThrow(
      new ValueError(
        "toToken 'BTC' is native bitcoin, but the destination chain is base (toChain defaults " +
          "to the source chain): pass toChain: 'bitcoin'"
      )
    )
    expect(client.getQuote).not.toHaveBeenCalled()
  })

  test('as fromToken on a non-bitcoin source is refused', async () => {
    const { sw } = setup()
    await expect(
      sw.quoteSwidge({ ...OFFRAMP, fromToken: 'btc', toToken: USDC_BASE, toChain: 'base' })
    ).rejects.toThrow(
      new ValueError("fromToken 'BTC' is native bitcoin, but the source chain is base")
    )
  })
})

describe('fee caps', () => {
  // Live quote: network fees $0 + $0.65 on a $99.82 input; no protocol fee. USD values are
  // rounded to the cent, so each fee line counts at +$0.005 and the input at −$0.005:
  // $0.66 / $99.815 = 66.1 bps.
  test('maxNetworkFeeBps below the quote refuses before create-order', async () => {
    const { sw, client } = setup({ config: { maxNetworkFeeBps: 50 } })
    const err = await sw.swidge(OFFRAMP).catch((e) => e)
    expect(err).toBeInstanceOf(MaximumFeeExceededError)
    expect(err.message).toBe(
      'network fee of up to 66.1 bps ($0.66 on $99.82) exceeds maxNetworkFeeBps (50)'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a sub-cent fee reported as $0 still counts: fees are taken at their rounding bound', async () => {
    // Reported: $0.65 / $99.82 = 65.1 bps — under 66. Upper bound: 66.1 bps — over.
    const { sw, client } = setup({ config: { maxNetworkFeeBps: 66 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toBeInstanceOf(MaximumFeeExceededError)
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('a fee exactly at the cap proceeds (fixed-point, no float drift)', async () => {
    const quote = offrampQuote()
    quote.offramp.inputAmount.usd = '100.005'
    quote.offramp.feeBreakdown.solverFee.amount = '0'
    quote.offramp.feeBreakdown.inclusionFee.usd = '0.295'
    // ($0.295 + $0.005) / ($100.005 − $0.005) = 30 bps exactly
    await expect(
      setup({ quote, config: { maxNetworkFeeBps: 30 } }).sw.swidge(OFFRAMP)
    ).resolves.toMatchObject({ id: 'order-offramp' })
    await expect(
      setup({ quote, config: { maxNetworkFeeBps: 29.99 } }).sw.swidge(OFFRAMP)
    ).rejects.toThrow(
      'network fee of up to 30.0 bps ($0.3 on $100.005) exceeds maxNetworkFeeBps (29.99)'
    )
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
        'protocol fee of up to 200.9 bps ($2.005 on $99.82) exceeds maxProtocolFeeBps (50)',
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

  test('fails closed when a capped fee has an empty USD string', async () => {
    const quote = offrampQuote()
    quote.offramp.feeBreakdown.inclusionFee.usd = ''
    const { sw } = setup({ quote, config: { maxNetworkFeeBps: 10_000 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'cannot verify maxNetworkFeeBps: the quote has no USD price for the bitcoin transaction ' +
        'inclusion fee'
    )
  })

  test('fails closed when an offramp quote has no fee breakdown', async () => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    delete quote.offramp.feeBreakdown
    const { sw, client } = setup({ quote: quote as never, config: { maxProtocolFeeBps: 10_000 } })
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'cannot verify maxProtocolFeeBps: the offramp quote has no fee breakdown',
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

  test('a fee under an unknown breakdown key is reported as `other` and counts against every cap', async () => {
    const quote = offrampQuote()
    Object.assign(quote.offramp.feeBreakdown, {
      bridgeFee: { amount: '500000', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0.50' },
    })
    const { sw, client } = setup({ quote, config: { maxNetworkFeeBps: 100 } })
    // ($0 + $0.65 + $0.50 + 3 × $0.005) / $99.815 = 116.7 bps
    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      'network fee of up to 116.7 bps ($1.165 on $99.82) exceeds maxNetworkFeeBps (100)'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
    // A protocol-only cap catches it too: $0.505 / $99.815 = 50.6 bps
    await expect(
      setup({ quote, config: { maxProtocolFeeBps: 40 } }).sw.swidge(OFFRAMP)
    ).rejects.toThrow(
      'protocol fee of up to 50.6 bps ($0.505 on $99.82) exceeds maxProtocolFeeBps (40)'
    )
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
    await sw.swidge({
      ...OFFRAMP,
      toToken: USDT0_ARBITRUM,
      toChain: 'arbitrum',
      recipient: '0xrcpt',
    })
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
    const { sw, client } = setup({ quote: SAME_CHAIN_SWAP(), order: tokenSwapOrder() })
    const res = await sw.swap({
      tokenIn: USDT_BASE,
      tokenOut: USDC_BASE,
      tokenInAmount: 100_000_000n,
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
    // WDK's bridge() asks for the same token address on the target chain. Real token-swap quotes
    // carry no fee breakdown; one is added here so the network/protocol split has lines to sort.
    const quote = tokenSwapQuote('base', 'arbitrum', { dstToken: USDT_BASE })
    Object.assign(quote.tokenSwap, {
      feeBreakdown: {
        solverFee: { amount: '300', address: USDT_BASE, chain: 'base', usd: '0' },
        executionFee: { amount: '200', address: USDT_BASE, chain: 'base', usd: '0' },
        protocolFee: { amount: '150', address: USDT_BASE, chain: 'base', usd: '0' },
      },
    })
    const { sw, client } = setup({ quote, order: tokenSwapOrder() })
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
    // network: solver 300 + execution 200; protocol: 150.
    expect(res).toEqual({ hash: 'order-swap', fee: 500n, bridgeFee: 150n })
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

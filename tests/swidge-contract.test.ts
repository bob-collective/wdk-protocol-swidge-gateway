// WDK SwidgeProtocol contract, exercised through GatewaySwidge's public API: amounts, minAmountOut,
// fee caps, read-only accounts, recipients and the inherited swap()/bridge().
import { beforeEach, describe, test, expect, vi } from 'vitest'
import {
  AccountRequiredError,
  ERR,
  GatewaySwidge,
  MaximumFeeExceededError,
  SwapError,
  SwidgeError,
  SwidgeErrorReason,
  ValueError,
} from '../src/index.js'
import type { GatewayClient, GatewaySwidgeConfig } from '../src/index.js'
import { gatewayError } from './helpers.js'
import {
  USDC_BASE,
  USDT_BASE,
  USDT0_ARBITRUM,
  USDT_ETHEREUM,
  ZERO,
  offrampOrder,
  offrampQuote,
  tokenSwapOrder,
  tokenSwapQuote,
} from './fixtures/gateway.js'

const getQuote = vi.fn()
const createOrder = vi.fn()
const client = { getQuote, createOrder } as unknown as GatewayClient

type Quote = Partial<ReturnType<typeof offrampQuote> & ReturnType<typeof tokenSwapQuote>>

class DummyEvmAccount {
  sendTransaction = vi.fn(async () => ({ hash: '0xtxhash' }))
  quoteSendTransaction = vi.fn(async () => ({ fee: 1n }))
  async getAddress() {
    return '0xsender'
  }
}

/** Stub the gateway with `quote`/`order` and build a Base-sourced GatewaySwidge. */
function setup(
  opts: { quote?: Quote; order?: unknown; account?: unknown; config?: GatewaySwidgeConfig } = {}
) {
  const { quote = offrampQuote(), order = offrampOrder(), account = new DummyEvmAccount() } = opts
  getQuote.mockResolvedValue(quote)
  createOrder.mockResolvedValue(order)
  const sw = new GatewaySwidge(account as never, { fromChain: 'base', client, ...opts.config })
  return { sw, account: account as DummyEvmAccount }
}

/** Base USDT → BTC, without an amount. */
const ROUTE = { fromToken: USDT_BASE, toToken: 'BTC', toChain: 'bitcoin', recipient: 'bc1qrcpt' }
const OFFRAMP = { ...ROUTE, fromTokenAmount: 100_000_000n }
const OFFRAMP_PARAMS = {
  srcChain: 'base',
  dstChain: 'bitcoin',
  srcToken: USDT_BASE,
  dstToken: ZERO,
  amount: '100000000',
  recipient: 'bc1qrcpt',
  sender: '0xsender',
  refundAddress: '0xsender',
}
const OFFRAMP_ORDER_BODY = { offramp: offrampQuote().offramp }
const OFFRAMP_FEES = [
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
]
/** Base USDT → Base USDC, paid out to the sender. */
const SAME_CHAIN_SWAP = () =>
  tokenSwapQuote('base', 'base', { dstToken: USDC_BASE, recipient: '0xsender' })

const READ_ONLY = new AccountRequiredError(
  'swidge() needs a full account that implements sendTransaction(); a read-only account can only ' +
    'quote'
)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('swidge(): result', () => {
  test('returns the order id, source tx, per-token fees and the slippage floor', async () => {
    const { sw } = setup()

    const result = await sw.swidge(OFFRAMP)

    expect(getQuote).toHaveBeenCalledWith(OFFRAMP_PARAMS)
    expect(createOrder).toHaveBeenCalledWith(OFFRAMP_ORDER_BODY)
    expect(result).toEqual({
      id: 'order-offramp',
      hash: '0xtxhash',
      fees: OFFRAMP_FEES,
      transactions: [{ hash: '0xtxhash', chain: 'base', type: 'source' }],
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 133_315n,
      // 133315 × (1 − 50 bps)
      toTokenAmountMin: 132_648n,
    })
  })
})

describe('amounts', () => {
  const EXACT_OUT = new ValueError(
    'exact-out swidges (toTokenAmount) are not supported by the BOB Gateway: pass fromTokenAmount'
  )

  test('swidge refuses toTokenAmount (exact-out) before any gateway call', async () => {
    const { sw } = setup()

    await expect(sw.swidge({ ...ROUTE, toTokenAmount: 133_315n })).rejects.toThrow(EXACT_OUT)
    expect(getQuote).not.toHaveBeenCalled()
  })

  test('quoteSwidge refuses toTokenAmount too', async () => {
    const { sw } = setup()

    await expect(sw.quoteSwidge({ ...ROUTE, toTokenAmount: 1n })).rejects.toThrow(EXACT_OUT)
  })

  test('a non-integer fromTokenAmount is a ValueError, not a gateway 400', async () => {
    const { sw } = setup()

    await expect(sw.quoteSwidge({ ...ROUTE, fromTokenAmount: 1.5 })).rejects.toThrow(
      new ValueError('fromTokenAmount must be a non-negative integer amount in base units, got 1.5')
    )
    expect(getQuote).not.toHaveBeenCalled()
  })

  test('a missing fromTokenAmount is refused instead of quoting amount=0', async () => {
    const { sw } = setup()

    // @ts-expect-error: neither amount given
    await expect(sw.quoteSwidge(ROUTE)).rejects.toThrow(
      new ValueError('fromTokenAmount is required')
    )
    expect(getQuote).not.toHaveBeenCalled()
  })
})

describe('minAmountOut', () => {
  const belowFloor = (min: bigint, minAmountOut: bigint) =>
    `quote guarantees at least ${min} of the destination token after slippage, below ` +
    `minAmountOut ${minAmountOut}`

  test('a slippage floor below minAmountOut refuses before create-order', async () => {
    const { sw, account } = setup()

    await expect(sw.swidge({ ...OFFRAMP, minAmountOut: 132_649n })).rejects.toThrow(
      new SwidgeError(belowFloor(132_648n, 132_649n), {
        reason: SwidgeErrorReason.COULD_NOT_MET_THRESHOLD,
      })
    )
    expect(createOrder).not.toHaveBeenCalled()
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('a floor exactly at minAmountOut proceeds', async () => {
    const { sw } = setup()

    await sw.swidge({ ...OFFRAMP, minAmountOut: 132_648 })

    expect(createOrder).toHaveBeenCalledWith(OFFRAMP_ORDER_BODY)
  })

  test('simulateSwidge applies it too', async () => {
    const { sw } = setup()

    await expect(sw.simulateSwidge({ ...OFFRAMP, minAmountOut: 200_000n })).rejects.toThrow(
      new SwidgeError(belowFloor(132_648n, 200_000n), {
        reason: SwidgeErrorReason.COULD_NOT_MET_THRESHOLD,
      })
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('swap() forwards it and surfaces the refusal as a SwapError', async () => {
    const { sw } = setup({ quote: SAME_CHAIN_SWAP(), order: tokenSwapOrder() })
    const reason = SwidgeErrorReason.COULD_NOT_MET_THRESHOLD
    const message = belowFloor(98_300_919n, 99_000_000n)

    await expect(
      sw.swap({
        tokenIn: USDT_BASE,
        tokenOut: USDC_BASE,
        tokenInAmount: 100_000_000n,
        minAmountOut: 99_000_000n,
      })
    ).rejects.toThrow(
      new SwapError(message, { reason, cause: new SwidgeError(message, { reason }) })
    )
  })

  // create-order posts only the requested variant, so the floor must come from it — not from
  // another variant key the gateway might add, which would be read first (onramp > offramp).
  test('reads the floor from the requested variant, not another key in the quote', async () => {
    const quote = offrampQuote()
    const onramp = {
      ...quote.offramp,
      outputAmount: { ...quote.offramp.outputAmount, amount: '1' },
    }
    const { sw } = setup({ quote: { ...quote, onramp } as never })

    await sw.swidge({ ...OFFRAMP, minAmountOut: 132_648n })

    expect(createOrder).toHaveBeenCalledWith(OFFRAMP_ORDER_BODY)
  })

  test('a quote without the requested variant is a gateway error before create-order', async () => {
    const { sw } = setup({ quote: SAME_CHAIN_SWAP() })

    await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.HTTP, 'get-quote returned no offramp quote')
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test.each([
    [1.5, '1.5'],
    // BigInt('') is 0n: an empty string must not become a zero floor.
    ['', ''],
  ])('a minAmountOut of %j is a ValueError', async (minAmountOut, shown) => {
    const { sw } = setup()

    await expect(sw.swidge({ ...OFFRAMP, minAmountOut })).rejects.toThrow(
      new ValueError(
        `minAmountOut must be a non-negative integer amount in base units, got ${shown}`
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
  })

  test.each([
    ['address', USDT_BASE, `${USDT_BASE} on bitcoin`],
    ['chain', 'base', `${ZERO} on base`],
  ])(
    "a quote whose output %s is not the requested one is refused: the floor's units are unknown",
    async (field, value, got) => {
      const quote = offrampQuote()
      ;(quote.offramp.outputAmount as Record<string, string>)[field] = value
      const { sw } = setup({ quote })

      await expect(sw.swidge({ ...OFFRAMP, minAmountOut: 1n })).rejects.toMatchObject(
        gatewayError(
          ERR.VALIDATION,
          `cannot verify minAmountOut: the quote's output is ${got}, not the requested ${ZERO} ` +
            'on bitcoin'
        )
      )
      expect(createOrder).not.toHaveBeenCalled()
    }
  )

  test('an EVM output address in another letter case is the same token', async () => {
    const quote = tokenSwapQuote('base', 'base', {
      dstToken: '0x' + USDC_BASE.slice(2).toUpperCase(),
      recipient: '0xsender',
    })
    const { sw } = setup({ quote, order: tokenSwapOrder() })

    await sw.swap({
      tokenIn: USDT_BASE,
      tokenOut: USDC_BASE,
      tokenInAmount: 100_000_000n,
      minAmountOut: 1n,
    })

    expect(createOrder).toHaveBeenCalledTimes(1)
  })

  test('a minAmountOut of 0 holds for any output, so it is not checked', async () => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    quote.offramp.slippage = undefined
    const { sw } = setup({ quote: quote as Quote })

    await sw.swidge({ ...OFFRAMP, minAmountOut: 0n })

    expect(createOrder).toHaveBeenCalledTimes(1)
  })

  test.each([undefined, ''])(
    'a quote whose slippage echo is %j is refused: the estimate is not a floor',
    async (slippage) => {
      const quote = offrampQuote() as { offramp: Record<string, unknown> }
      quote.offramp.slippage = slippage
      const { sw } = setup({ quote: quote as Quote })

      await expect(sw.swidge({ ...OFFRAMP, minAmountOut: 1n })).rejects.toMatchObject(
        gatewayError(
          ERR.VALIDATION,
          'cannot verify minAmountOut: the quote carries no slippage to derive its minimum from'
        )
      )
      expect(createOrder).not.toHaveBeenCalled()
    }
  )
})

describe("the 'BTC' alias", () => {
  // 'BTC' maps to the zero address, which on an EVM chain is its gas token.
  test('as toToken without toChain is refused, not swapped into the source chain gas token', async () => {
    const { sw } = setup()

    await expect(sw.swidge({ ...OFFRAMP, toChain: undefined })).rejects.toThrow(
      new ValueError(
        "toToken 'BTC' is native bitcoin, but the destination chain is base (toChain defaults " +
          "to the source chain): pass toChain: 'bitcoin'"
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
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
  const networkOver = (cap: number) =>
    new MaximumFeeExceededError(
      `network fee of up to 66.1 bps ($0.66 on $99.82) exceeds maxNetworkFeeBps (${cap})`,
      {}
    )

  test('maxNetworkFeeBps below the quote refuses before create-order', async () => {
    const { sw } = setup({ config: { maxNetworkFeeBps: 50 } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(networkOver(50))
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('a sub-cent fee reported as $0 still counts: fees are taken at their rounding bound', async () => {
    // Reported: $0.65 / $99.82 = 65.1 bps — under 66. Upper bound: 66.1 bps — over.
    const { sw } = setup({ config: { maxNetworkFeeBps: 66 } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(networkOver(66))
    expect(createOrder).not.toHaveBeenCalled()
  })

  describe('at the cap boundary (fixed-point, no float drift)', () => {
    // ($0.295 + $0.005) / ($100.005 − $0.005) = 30 bps exactly
    const atThirtyBps = () => {
      const quote = offrampQuote()
      quote.offramp.inputAmount.usd = '100.005'
      quote.offramp.feeBreakdown.solverFee.amount = '0'
      quote.offramp.feeBreakdown.inclusionFee.usd = '0.295'
      return quote
    }

    test('a fee exactly at the cap proceeds', async () => {
      const { sw } = setup({ quote: atThirtyBps(), config: { maxNetworkFeeBps: 30 } })

      await sw.swidge(OFFRAMP)

      expect(createOrder).toHaveBeenCalledWith({ offramp: atThirtyBps().offramp })
    })

    test('a fractional cap just below it refuses', async () => {
      const { sw } = setup({ quote: atThirtyBps(), config: { maxNetworkFeeBps: 29.99 } })

      await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
        new MaximumFeeExceededError(
          'network fee of up to 30.0 bps ($0.3 on $100.005) exceeds maxNetworkFeeBps (29.99)',
          {}
        )
      )
    })
  })

  test('maxNetworkFeeBps above the quote proceeds', async () => {
    const { sw } = setup({ config: { maxNetworkFeeBps: 70n } })

    await sw.swidge(OFFRAMP)

    expect(createOrder).toHaveBeenCalledWith(OFFRAMP_ORDER_BODY)
  })

  test('a per-call cap overrides the instance cap', async () => {
    const { sw } = setup({ config: { maxNetworkFeeBps: 1000 } })

    await expect(sw.swidge(OFFRAMP, { maxNetworkFeeBps: 10 })).rejects.toThrow(networkOver(10))
  })

  test('simulateSwidge takes per-call caps too', async () => {
    const { sw } = setup()

    await expect(sw.simulateSwidge(OFFRAMP, { maxNetworkFeeBps: 10 })).rejects.toThrow(
      networkOver(10)
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('maxProtocolFeeBps refuses a protocol fee over the cap', async () => {
    const quote = offrampQuote()
    quote.offramp.feeBreakdown.protocolFee = {
      amount: '2000000',
      address: USDT_ETHEREUM,
      chain: 'ethereum',
      usd: '2.00',
    }
    const { sw } = setup({ quote, config: { maxProtocolFeeBps: 50 } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'protocol fee of up to 200.9 bps ($2.005 on $99.82) exceeds maxProtocolFeeBps (50)',
        {}
      )
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test.each([
    ['no USD price', null],
    ['an empty USD string', ''],
  ])('fails closed when a capped fee has %s', async (_label, usd) => {
    const quote = offrampQuote()
    quote.offramp.feeBreakdown.inclusionFee.usd = usd as string
    const { sw } = setup({ quote, config: { maxNetworkFeeBps: 10_000 } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'cannot verify maxNetworkFeeBps: the quote has no USD price for the bitcoin transaction ' +
          'inclusion fee',
        {}
      )
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  // `{}` or a breakdown with no fee amount yields no fee lines: as unverifiable as none at all.
  test.each([
    ['absent', undefined],
    ['empty', {}],
    ['not an object', 'none'],
    ['without a fee amount', { fastestFeeRate: '5' }],
  ])('fails closed when an offramp quote’s fee breakdown is %s', async (_label, breakdown) => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    quote.offramp.feeBreakdown = breakdown
    const { sw } = setup({ quote: quote as Quote, config: { maxProtocolFeeBps: 10_000 } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'cannot verify maxProtocolFeeBps: the offramp quote has no fee breakdown',
        {}
      )
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('fails closed when the input has no USD price', async () => {
    const quote = offrampQuote()
    quote.offramp.inputAmount.usd = null as unknown as string
    const { sw } = setup({ quote, config: { maxNetworkFeeBps: 10_000 } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new MaximumFeeExceededError(
        'cannot verify maxNetworkFeeBps: the quote has no USD price for the input amount',
        {}
      )
    )
  })

  test('without caps, missing USD prices are not checked', async () => {
    const quote = offrampQuote()
    quote.offramp.inputAmount.usd = null as unknown as string
    const { sw } = setup({ quote })

    await sw.swidge(OFFRAMP)

    expect(createOrder).toHaveBeenCalledWith({ offramp: quote.offramp })
  })

  describe('a fee under an unknown breakdown key', () => {
    const withBridgeFee = () => {
      const quote = offrampQuote()
      Object.assign(quote.offramp.feeBreakdown, {
        bridgeFee: { amount: '500000', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0.50' },
      })
      return quote
    }

    test.each([
      [
        // ($0 + $0.65 + $0.50 + 3 × $0.005) / $99.815 = 116.7 bps
        { maxNetworkFeeBps: 100 },
        'network fee of up to 116.7 bps ($1.165 on $99.82) exceeds maxNetworkFeeBps (100)',
      ],
      [
        // $0.505 / $99.815 = 50.6 bps
        { maxProtocolFeeBps: 40 },
        'protocol fee of up to 50.6 bps ($0.505 on $99.82) exceeds maxProtocolFeeBps (40)',
      ],
    ])('counts against every cap — %j', async (config, message) => {
      const { sw } = setup({ quote: withBridgeFee(), config })

      await expect(sw.swidge(OFFRAMP)).rejects.toThrow(new MaximumFeeExceededError(message, {}))
      expect(createOrder).not.toHaveBeenCalled()
    })

    test('is reported as an `other` fee named after its key', async () => {
      const { sw } = setup({ quote: withBridgeFee() })

      const { fees } = await sw.quoteSwidge(OFFRAMP)

      expect(fees).toEqual([
        ...OFFRAMP_FEES,
        {
          type: 'other',
          amount: 500_000n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'bridgeFee',
        },
      ])
    })
  })

  test('a cap that is not a finite, non-negative number is a ValueError, not a silent pass', async () => {
    const { sw } = setup({ config: { maxNetworkFeeBps: Number.NaN } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(
      new ValueError('maxNetworkFeeBps must be a finite, non-negative number of bps, got NaN')
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('token swaps report no fees, so caps pass — bound them with minAmountOut', async () => {
    const { sw } = setup({
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

    expect(createOrder).toHaveBeenCalledWith({ tokenSwap: tokenSwapQuote().tokenSwap })
  })
})

describe('read-only accounts', () => {
  test('an EVM account without sendTransaction is refused before any gateway call', async () => {
    const { sw } = setup({ account: { getAddress: async () => '0xsender' } })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(READ_ONLY)
    expect(getQuote).not.toHaveBeenCalled()
  })

  test('a Bitcoin account without signTransaction is refused', async () => {
    const { sw } = setup({
      account: { getAddress: async () => 'bc1qsender', sendTransaction: vi.fn() },
      config: { fromChain: 'bitcoin' },
    })

    await expect(
      sw.swidge({ ...OFFRAMP, fromToken: 'BTC', toToken: USDT_BASE, toChain: 'base' })
    ).rejects.toThrow(
      new AccountRequiredError(
        'swidge() needs a full account that implements signTransaction(); a read-only account ' +
          'can only quote'
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
  })

  test('no account at all is refused', async () => {
    const sw = new GatewaySwidge(undefined, { fromChain: 'base', client })

    await expect(sw.swidge(OFFRAMP)).rejects.toThrow(READ_ONLY)
  })

  test('a read-only account can still quote', async () => {
    const { sw } = setup({ account: { getAddress: async () => '0xsender' } })

    const quote = await sw.quoteSwidge(OFFRAMP)

    expect(quote).toEqual({
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 133_315n,
      toTokenAmountMin: 132_648n,
      fees: OFFRAMP_FEES,
      estimatedDuration: 648,
      priceImpact: -0.0045,
      affiliateApplied: false,
    })
  })
})

describe('recipient', () => {
  test('a same-chain swap() without `to` pays out to the sender', async () => {
    const { sw } = setup({ quote: SAME_CHAIN_SWAP(), order: tokenSwapOrder() })

    const result = await sw.swap({
      tokenIn: USDT_BASE,
      tokenOut: USDC_BASE,
      tokenInAmount: 100_000_000n,
    })

    expect(getQuote).toHaveBeenCalledWith({
      srcChain: 'base',
      dstChain: 'base',
      srcToken: USDT_BASE,
      dstToken: USDC_BASE,
      amount: '100000000',
      recipient: '0xsender',
      sender: '0xsender',
      refundAddress: '0xsender',
    })
    expect(result).toEqual({
      hash: 'order-swap',
      fee: 0n,
      tokenInAmount: 100_000_000n,
      tokenOutAmount: 99_797_888n,
    })
  })

  test('a cross-chain route without a recipient is refused before quoting', async () => {
    const { sw } = setup()

    await expect(sw.quoteSwidge({ ...OFFRAMP, recipient: undefined })).rejects.toThrow(
      new ValueError('recipient is required for cross-chain routes (base → bitcoin)')
    )
    expect(getQuote).not.toHaveBeenCalled()
  })
})

describe('chain ids', () => {
  test('a numeric toChain (WDK types it string | number) is sent as a string', async () => {
    const { sw } = setup({ quote: tokenSwapQuote('base', '8453'), order: tokenSwapOrder() })

    await sw.quoteSwidge({
      ...OFFRAMP,
      toToken: USDT0_ARBITRUM,
      toChain: 8453,
      recipient: '0xrcpt',
    })

    expect(getQuote).toHaveBeenCalledWith({
      srcChain: 'base',
      dstChain: '8453',
      srcToken: USDT_BASE,
      dstToken: USDT0_ARBITRUM,
      amount: '100000000',
      recipient: '0xrcpt',
      sender: '0xsender',
      refundAddress: '0xsender',
    })
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
    const { sw } = setup({ quote, order: tokenSwapOrder() })

    const result = await sw.bridge({
      token: USDT_BASE,
      targetChain: 'arbitrum',
      recipient: '0xrcpt',
      amount: 100_000_000n,
    })

    expect(getQuote).toHaveBeenCalledWith({
      srcChain: 'base',
      dstChain: 'arbitrum',
      srcToken: USDT_BASE,
      dstToken: USDT_BASE,
      amount: '100000000',
      recipient: '0xrcpt',
      sender: '0xsender',
      refundAddress: '0xsender',
    })
    // network: solver 300 + execution 200; protocol: 150; affiliate is neither.
    expect(result).toEqual({ hash: 'order-swap', fee: 500n, bridgeFee: 150n })
  })

  test('quoteBridge without a recipient is a ValueError, not a gateway 400', async () => {
    const { sw } = setup({ quote: tokenSwapQuote(), order: tokenSwapOrder() })

    await expect(
      sw.quoteBridge({ token: USDT_BASE, targetChain: 'arbitrum', amount: 1n } as never)
    ).rejects.toThrow(
      new ValueError('recipient is required for cross-chain routes (base → arbitrum)')
    )
    expect(getQuote).not.toHaveBeenCalled()
  })
})

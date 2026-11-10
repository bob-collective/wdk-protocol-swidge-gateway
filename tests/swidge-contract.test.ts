// WDK SwidgeProtocol contract, exercised through GatewaySwidge's public API: amounts, minAmountOut,
// fee caps, quote binding, read-only accounts, recipients and the inherited swap()/bridge().
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
/** Base USDT → Arbitrum USDT0, without a chain-specific quote. */
const SWAP_TO_ARBITRUM = {
  fromToken: USDT_BASE,
  toToken: USDT0_ARBITRUM,
  toChain: 'arbitrum',
  recipient: '0xrcpt',
  fromTokenAmount: 100_000_000n,
}
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
      const { sw, account } = setup({ quote })

      await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
        gatewayError(ERR.VALIDATION, `quote ${field} ${got} does not match the requested ${want}`)
      )
      expect(createOrder).not.toHaveBeenCalled()
      expect(account.sendTransaction).not.toHaveBeenCalled()
    }
  )

  test('echoed addresses compare case-insensitively (the gateway checksums EVM addresses)', async () => {
    const { sw } = setup()

    await sw.swidge({ ...OFFRAMP, fromToken: USDT_BASE.toLowerCase() })

    expect(createOrder).toHaveBeenCalledWith(OFFRAMP_ORDER_BODY)
  })

  // Token addresses repeat across chains (USDT0 has one address on many), so the token echo alone
  // cannot pin the route: the chains are bound too.
  test.each([
    ['the output amount chain', 'arbitrum', 'ethereum', 'arbitrum', 'ethereum'],
    ['a top-level dstChain echo', 'ethereum', 'arbitrum', 'ethereum', 'arbitrum'],
  ])(
    'a token swap whose %s differs from the request is refused',
    async (_label, quoteChain, toChain, got, want) => {
      const quote = tokenSwapQuote('base', 'arbitrum')
      quote.tokenSwap.dstChain = quoteChain
      const { sw } = setup({ quote, order: tokenSwapOrder() })

      await expect(sw.swidge({ ...SWAP_TO_ARBITRUM, toChain })).rejects.toMatchObject(
        gatewayError(
          ERR.VALIDATION,
          `quote destination chain ${got} does not match the requested ${want}`
        )
      )
      expect(createOrder).not.toHaveBeenCalled()
    }
  )

  test('chains compare case-insensitively, and both spellings of HyperEVM match', async () => {
    const quote = tokenSwapQuote('Base', 'hyperliquid')
    const { sw } = setup({ quote, order: tokenSwapOrder() })

    await sw.swidge({ ...SWAP_TO_ARBITRUM, toChain: 'hyperevm' })

    expect(createOrder).toHaveBeenCalledWith({ tokenSwap: quote.tokenSwap })
  })

  test.each([
    ['two variants', { ...offrampQuote(), ...tokenSwapQuote() }, 'offramp + tokenSwap'],
    ['another variant', tokenSwapQuote(), 'tokenSwap'],
  ])('a quote carrying %s is refused', async (_label, quote, got) => {
    const { sw } = setup({ quote: quote as Quote })

    await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, `expected a offramp quote, got ${got}`)
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  // Mapping the quote parses every amount in it, so a malformed one refuses before create-order.
  // The input amount fails the same way as the others — hex included, though BigInt reads
  // '0x5f5e100' as the requested 100000000.
  test.each([
    ['inputAmount.amount', '1e8'],
    ['inputAmount.amount', '0x5f5e100'],
    ['outputAmount.amount', '1e8'],
    ['feeBreakdown.solverFee.amount', '9.95'],
    ['feeBreakdown.solverFee.amount', '0x3e3'],
    ['feeBreakdown.solverFee.amount', ''],
  ])('a quote %s of %j is refused before create-order', async (field, value) => {
    const quote = offrampQuote()
    const path = field.split('.')
    let target = quote.offramp as unknown as Record<string, unknown>
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
    target[path[path.length - 1]] = value
    const { sw, account } = setup({ quote })

    await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.HTTP, `quote ${field} is not an integer amount in base units: ${value}`)
    )
    expect(createOrder).not.toHaveBeenCalled()
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('slippage binding', () => {
  // The quote's slippage sets the floor the order executes with, so it may not be looser.
  test.each([
    ['per call', { slippage: 0.003 }, {}],
    ['as the configured default', {}, { slippage: 0.003 }],
  ])(
    'a quote echoing a looser slippage than requested %s is refused',
    async (_label, call, config) => {
      const { sw } = setup({ config })

      await expect(sw.swidge({ ...OFFRAMP, ...call })).rejects.toMatchObject(
        gatewayError(ERR.VALIDATION, 'quote slippage 50 is looser than the requested 30 bps')
      )
      expect(createOrder).not.toHaveBeenCalled()
    }
  )

  test.each([
    ['per call', NaN, { slippage: NaN }, {}],
    ['per call', Infinity, { slippage: Infinity }, {}],
    ['per call', -0.01, { slippage: -0.01 }, {}],
    ['per call', 1.5, { slippage: 1.5 }, {}],
    ['as the configured default', NaN, {}, { slippage: NaN }],
  ])(
    'a slippage set %s to %s is a ValueError before any gateway call',
    async (_label, value, call, config) => {
      const { sw } = setup({ config })

      await expect(sw.swidge({ ...OFFRAMP, ...call })).rejects.toThrow(
        new ValueError(`slippage must be a fraction between 0 and 1, got ${value}`)
      )
      expect(getQuote).not.toHaveBeenCalled()
    }
  )

  test('a requested slippage the quote does not echo is refused', async () => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    delete quote.offramp.slippage
    const { sw } = setup({ quote: quote as Quote })

    await expect(sw.swidge({ ...OFFRAMP, slippage: 0.005 })).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, 'quote slippage undefined is looser than the requested 50 bps')
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test.each([
    [0.005, '50'],
    [0.01, '100'],
  ])('an echo at or under a requested slippage of %s proceeds', async (slippage, bps) => {
    const { sw } = setup()

    await sw.swidge({ ...OFFRAMP, slippage })

    expect(getQuote).toHaveBeenCalledWith({ ...OFFRAMP_PARAMS, slippage: bps })
    expect(createOrder).toHaveBeenCalledWith(OFFRAMP_ORDER_BODY)
  })
})

describe('affiliate binding', () => {
  const fee = (amount: string) => ({
    amount,
    address: USDT_ETHEREUM,
    chain: 'ethereum',
    usd: '0.1',
  })
  /** The live offramp quote, echoing `fields` and charging `affiliateFee`. */
  const withAffiliates = (fields: Record<string, unknown>, affiliateFee = '0') => {
    const quote = offrampQuote()
    Object.assign(quote.offramp, fields)
    quote.offramp.feeBreakdown.affiliateFee = fee(affiliateFee)
    return quote as Quote
  }

  test.each([
    [
      'an affiliates[] entry',
      { affiliates: [{ address: '0xevil', fee: fee('500') }] },
      '500',
      '0xevil',
    ],
    ['affiliateAddress', { affiliateAddress: '0xevil' }, '0', '0xevil'],
    ['an entry with no address', { affiliates: [{ fee: fee('500') }] }, '500', 'undefined'],
  ])(
    'with no affiliates configured, a quote paying %s is refused',
    async (_label, fields, amount, shown) => {
      const { sw } = setup({ quote: withAffiliates(fields, amount) })

      await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
        gatewayError(
          ERR.VALIDATION,
          `quote pays affiliate ${shown}, which the request did not include`
        )
      )
      expect(createOrder).not.toHaveBeenCalled()
    }
  )

  test('with no affiliates configured, an affiliate fee is refused even with no recipient', async () => {
    const { sw } = setup({ quote: withAffiliates({}, '1000') })

    await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.VALIDATION,
        'quote charges an affiliate fee of 1000, but the request included no affiliates'
      )
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('a token swap echoing an affiliate is refused (none is ever sent on token swaps)', async () => {
    const quote = SAME_CHAIN_SWAP()
    Object.assign(quote.tokenSwap, { affiliate: { address: '0xevil', bps: 100 } })
    const { sw } = setup({
      quote,
      order: tokenSwapOrder(),
      config: { affiliates: [{ address: '0xevil', bps: 100 }] },
    })

    await expect(
      sw.swap({ tokenIn: USDT_BASE, tokenOut: USDC_BASE, tokenInAmount: 100_000_000n })
    ).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, 'quote pays affiliate 0xevil, which the request did not include')
    )
    expect(createOrder).not.toHaveBeenCalled()
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
    const { sw } = setup({ quote, config: { affiliates: [{ address: '0xbob', bps: 10 }] } })

    await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, 'quote pays affiliate 0xevil, which the request did not include')
    )
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('configured affiliates echoed back (any case) proceed', async () => {
    const quote = withAffiliates(
      { affiliates: [{ address: '0xBob', fee: fee('500') }], affiliateAddress: '0xBOB' },
      '500'
    )
    const { sw } = setup({ quote, config: { affiliates: [{ address: '0xbob', bps: 10 }] } })

    await sw.swidge(OFFRAMP)

    expect(getQuote).toHaveBeenCalledWith({ ...OFFRAMP_PARAMS, affiliates: '0xbob:10' })
    expect(createOrder).toHaveBeenCalledWith({ offramp: quote.offramp })
  })
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

  test('fails closed when an offramp quote has no fee breakdown', async () => {
    const quote = offrampQuote() as { offramp: Record<string, unknown> }
    delete quote.offramp.feeBreakdown
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

describe('unsupported source chain', () => {
  // The gateway quotes Solana routes, but this module cannot sign there: without an up-front
  // refusal, the order's `solana` tx type would only be rejected after create-order.
  const FROM_SOLANA = {
    fromChain: 'solana',
    fromToken: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    toToken: 'BTC',
    toChain: 'bitcoin',
    recipient: 'bc1qrcpt',
    fromTokenAmount: 1_000_000n,
  }

  test.each(['swidge', 'simulateSwidge', 'getRequiredApproval'] as const)(
    '%s refuses a Solana source before any gateway call',
    async (method) => {
      const { sw } = setup()

      await expect(sw[method](FROM_SOLANA)).rejects.toMatchObject(
        gatewayError(ERR.NOT_SUPPORTED, "chain family 'solana' is not supported in v1")
      )
      expect(getQuote).not.toHaveBeenCalled()
      expect(createOrder).not.toHaveBeenCalled()
    }
  )
})

// quoteSwidge(): the get-quote request it sends, and how the response maps to a SwidgeQuote.
import { beforeEach, describe, test, expect, vi } from 'vitest'
import { ERR, GatewaySwidge, ValueError } from '../src/index.js'
import type { GatewayClient } from '../src/index.js'
import { gatewayError } from './helpers.js'
import {
  BTC_SENDER,
  EVM_RECIPIENT,
  USDT0_ARBITRUM,
  USDT_BASE,
  USDT_ETHEREUM,
  ZERO,
  offrampQuote,
  onrampQuote,
  tokenSwapQuote,
} from './fixtures/gateway.js'

const getQuote = vi.fn()
const client = { getQuote } as unknown as GatewayClient

const AFFILIATE_A = '0x00000000000000000000000000000000000000a1'
const AFFILIATE_B = '0x00000000000000000000000000000000000000b2'

const evmAccount = { getAddress: async () => '0xsender' }
const btcAccount = { getAddress: async () => BTC_SENDER }

/** Base USDT → BTC. */
const OFFRAMP = {
  fromToken: USDT_BASE,
  toToken: 'BTC',
  toChain: 'bitcoin',
  recipient: 'bc1qrcpt',
  fromTokenAmount: 100_000_000n,
}
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

/** BTC → Base USDT. */
const ONRAMP = {
  fromToken: 'BTC',
  toToken: USDT_BASE,
  toChain: 'base',
  recipient: EVM_RECIPIENT,
  fromTokenAmount: 50_000n,
}

const SOLVER_FEE_OFFRAMP = {
  type: 'network',
  amount: 995n,
  token: USDT_ETHEREUM,
  chain: 'ethereum',
  included: true,
  description: 'Solver fee',
}
const INCLUSION_FEE = {
  type: 'network',
  amount: 880n,
  token: ZERO,
  chain: 'bitcoin',
  included: true,
  description: 'Bitcoin transaction inclusion fee',
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('quoteSwidge: response', () => {
  test('an onramp: one fee line per breakdown entry, the floor from its string slippage echo', async () => {
    getQuote.mockResolvedValue(onrampQuote())
    const sw = new GatewaySwidge(btcAccount as never, { fromChain: 'bitcoin', client })

    const quote = await sw.quoteSwidge(ONRAMP)

    expect(quote).toEqual({
      fromTokenAmount: 50_000n,
      toTokenAmount: 37_141_289n,
      // 37141289 × (1 − 50 bps)
      toTokenAmountMin: 36_955_582n,
      fees: [
        { ...SOLVER_FEE_OFFRAMP, amount: 373n },
        {
          type: 'network',
          amount: 195_982n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Destination-chain execution fee',
        },
      ],
      estimatedDuration: 616,
      priceImpact: -0.0002,
      affiliateApplied: false,
    })
  })

  test('an onramp LayerZero fee is a network fee; a null priceImpact is left out', async () => {
    const response = onrampQuote()
    response.onramp.feeBreakdown.layerzeroFee.amount = '1200'
    response.onramp.priceImpact = null
    getQuote.mockResolvedValue(response)
    const sw = new GatewaySwidge(btcAccount as never, { fromChain: 'bitcoin', client })

    const quote = await sw.quoteSwidge(ONRAMP)

    expect(quote).toEqual({
      fromTokenAmount: 50_000n,
      toTokenAmount: 37_141_289n,
      toTokenAmountMin: 36_955_582n,
      fees: [
        { ...SOLVER_FEE_OFFRAMP, amount: 373n },
        {
          type: 'network',
          amount: 195_982n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Destination-chain execution fee',
        },
        {
          type: 'network',
          amount: 1_200n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'LayerZero messaging fee',
        },
      ],
      estimatedDuration: 616,
      affiliateApplied: false,
    })
  })

  test('an offramp with affiliates: every fee type, each in its own token, affiliates sent', async () => {
    const response = offrampQuote()
    response.offramp.feeBreakdown.protocolFee = {
      amount: '50000',
      address: USDT_ETHEREUM,
      chain: 'ethereum',
      usd: '0.05',
    }
    response.offramp.feeBreakdown.affiliateFee = {
      amount: '25000',
      address: USDT_ETHEREUM,
      chain: 'ethereum',
      usd: '0.02',
    }
    getQuote.mockResolvedValue(response)
    const sw = new GatewaySwidge(evmAccount as never, {
      fromChain: 'base',
      affiliates: [{ address: AFFILIATE_A, bps: 25 }],
      client,
    })

    const quote = await sw.quoteSwidge(OFFRAMP)

    expect(getQuote).toHaveBeenCalledWith({ ...OFFRAMP_PARAMS, affiliates: `${AFFILIATE_A}:25` })
    expect(quote).toEqual({
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 133_315n,
      // 133315 × (1 − 50 bps)
      toTokenAmountMin: 132_648n,
      fees: [
        SOLVER_FEE_OFFRAMP,
        INCLUSION_FEE,
        {
          type: 'protocol',
          amount: 50_000n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Gateway protocol fee',
        },
        {
          type: 'affiliate',
          amount: 25_000n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Affiliate fee',
        },
      ],
      estimatedDuration: 648,
      priceImpact: -0.0045,
      affiliateApplied: true,
    })
  })

  // The estimate is not a floor: with no slippage known, nothing below it is ruled out.
  test('without a slippage echo, toTokenAmountMin is 0', async () => {
    const response = offrampQuote() as { offramp: Record<string, unknown> }
    delete response.offramp.slippage
    getQuote.mockResolvedValue(response)
    const sw = new GatewaySwidge(evmAccount as never, { fromChain: 'base', client })

    const quote = await sw.quoteSwidge(OFFRAMP)

    expect(quote).toEqual({
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 133_315n,
      toTokenAmountMin: 0n,
      fees: [SOLVER_FEE_OFFRAMP, INCLUSION_FEE],
      estimatedDuration: 648,
      priceImpact: -0.0045,
      affiliateApplied: false,
    })
  })

  test('a token swap: no fee breakdown, and no affiliates sent — the gateway takes none', async () => {
    getQuote.mockResolvedValue(tokenSwapQuote())
    const sw = new GatewaySwidge(evmAccount as never, {
      fromChain: 'base',
      affiliates: [{ address: AFFILIATE_A, bps: 25 }],
      client,
    })

    const quote = await sw.quoteSwidge({
      fromToken: USDT_BASE,
      toToken: USDT0_ARBITRUM,
      toChain: 'arbitrum',
      recipient: '0xrcpt',
      fromTokenAmount: 100_000_000n,
    })

    expect(getQuote).toHaveBeenCalledWith({
      srcChain: 'base',
      dstChain: 'arbitrum',
      srcToken: USDT_BASE,
      dstToken: USDT0_ARBITRUM,
      amount: '100000000',
      recipient: '0xrcpt',
      sender: '0xsender',
      refundAddress: '0xsender',
    })
    expect(quote).toEqual({
      fromTokenAmount: 100_000_000n,
      toTokenAmount: 99_797_888n,
      // 99797888 × (1 − 150 bps)
      toTokenAmountMin: 98_300_919n,
      fees: [],
      estimatedDuration: 11,
      priceImpact: -0.002,
      affiliateApplied: false,
    })
  })
})

describe('quoteSwidge: request', () => {
  test.each(['BTC', 'btc', 'Btc', ZERO])(
    'native BTC given as %s goes out as the zero address',
    async (fromToken) => {
      getQuote.mockResolvedValue(onrampQuote())
      const sw = new GatewaySwidge(btcAccount as never, { fromChain: 'bitcoin', client })

      await sw.quoteSwidge({ ...ONRAMP, fromToken })

      expect(getQuote).toHaveBeenCalledWith({
        srcChain: 'bitcoin',
        dstChain: 'base',
        srcToken: ZERO,
        dstToken: USDT_BASE,
        amount: '50000',
        recipient: EVM_RECIPIENT,
        sender: BTC_SENDER,
        refundAddress: BTC_SENDER,
      })
    }
  )

  test('affiliates go out as address:bps pairs', async () => {
    getQuote.mockResolvedValue(offrampQuote())
    const sw = new GatewaySwidge(evmAccount as never, {
      fromChain: 'base',
      affiliates: [
        { address: AFFILIATE_A, bps: 50 },
        { address: AFFILIATE_B, bps: 25 },
      ],
      client,
    })

    await sw.quoteSwidge(OFFRAMP)

    expect(getQuote).toHaveBeenCalledWith({
      ...OFFRAMP_PARAMS,
      affiliates: `${AFFILIATE_A}:50,${AFFILIATE_B}:25`,
    })
  })

  test.each([
    [
      'more than five',
      [1, 2, 3, 4, 5, 6].map((i) => ({ address: `0x${String(i).padStart(40, '0')}`, bps: 1 })),
      'at most 5 affiliates',
    ],
    ['one without an address', [{ address: '', bps: 1 }], 'affiliate address required'],
    [
      'a duplicate',
      [
        { address: AFFILIATE_A, bps: 1 },
        { address: AFFILIATE_A, bps: 1 },
      ],
      `duplicate affiliate ${AFFILIATE_A}`,
    ],
    ['zero bps', [{ address: AFFILIATE_A, bps: 0 }], 'affiliate bps must be greater than zero'],
    [
      'over 1000 bps in total',
      [
        { address: AFFILIATE_A, bps: 600 },
        { address: AFFILIATE_B, bps: 500 },
      ],
      'total affiliate bps exceeds 1000',
    ],
  ])('refuses affiliates with %s, before quoting', async (_label, affiliates, message) => {
    const sw = new GatewaySwidge(evmAccount as never, { fromChain: 'base', affiliates, client })

    await expect(sw.quoteSwidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, message)
    )
    expect(getQuote).not.toHaveBeenCalled()
  })

  test.each([
    ['is omitted when neither the call nor the config sets it', {}, {}, undefined],
    ['comes from config.slippage, in bps', { slippage: 0.03 }, {}, '300'],
    ['comes from the call over the config', { slippage: 0.03 }, { slippage: 0.005 }, '50'],
  ])('slippage %s', async (_label, config, options, slippage) => {
    getQuote.mockResolvedValue(offrampQuote())
    const sw = new GatewaySwidge(evmAccount as never, { fromChain: 'base', client, ...config })

    await sw.quoteSwidge({ ...OFFRAMP, ...options })

    expect(getQuote).toHaveBeenCalledWith({ ...OFFRAMP_PARAMS, slippage })
  })

  test.each([
    ['the account address', {}, {}, '0xsender'],
    ['config.refundAddress over the account', { refundAddress: '0xconfig' }, {}, '0xconfig'],
    [
      'the call over config.refundAddress',
      { refundAddress: '0xconfig' },
      { refundAddress: '0xcall' },
      '0xcall',
    ],
  ])('refundAddress is %s', async (_label, config, options, refundAddress) => {
    getQuote.mockResolvedValue(offrampQuote())
    const sw = new GatewaySwidge(evmAccount as never, { fromChain: 'base', client, ...config })

    await sw.quoteSwidge({ ...OFFRAMP, ...options })

    expect(getQuote).toHaveBeenCalledWith({ ...OFFRAMP_PARAMS, refundAddress })
  })

  test('throws when the source chain is set on neither the call nor the config', async () => {
    const sw = new GatewaySwidge(evmAccount as never, { client })

    await expect(sw.quoteSwidge(OFFRAMP)).rejects.toThrow(
      new ValueError('source chain unknown: pass config.fromChain')
    )
    expect(getQuote).not.toHaveBeenCalled()
  })
})

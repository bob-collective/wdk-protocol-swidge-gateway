// swidge() execution: what is signed, sent and registered for each source family, and what the
// module refuses in a create-order response. The WDK contract checks that run before
// create-order (minAmountOut, fee caps) are in swidge-contract.test.ts.
import { beforeEach, describe, test, expect, vi } from 'vitest'
import { ERR, GatewaySwidge } from '../src/index.js'
import type { GatewayClient } from '../src/index.js'
import { BOB_BEARER_TOKEN, gatewayError } from './helpers.js'
import {
  ALLOWANCE_HOLDER,
  BTC_SENDER,
  DEPOSIT_ADDRESS,
  EVM_RECIPIENT,
  EXEC_100_USDT_BASE,
  USDT_BASE,
  USDT_ETHEREUM,
  ZERO,
  offrampOrder,
  offrampQuote,
  onrampOrder,
  onrampQuote,
} from './fixtures/gateway.js'
import { SIGNED_TXID, SIGNED_TX_HEX } from './fixtures/bitcoin.js'
import { BTC_RECIPIENT, OWNER, USDT, tronOfframpQuote } from './fixtures/tron.js'

const getQuote = vi.fn()
const createOrder = vi.fn()
const registerTx = vi.fn()
const client = { getQuote, createOrder, registerTx } as unknown as GatewayClient

beforeEach(() => {
  vi.resetAllMocks()
})

describe('swidge: onramp', () => {
  class DummyBtcAccount {
    signTransaction = vi.fn(async () => SIGNED_TX_HEX)
    async getAddress() {
      return BTC_SENDER
    }
  }

  const ONRAMP = {
    fromToken: 'BTC',
    toToken: USDT_BASE,
    toChain: 'base',
    recipient: EVM_RECIPIENT,
    fromTokenAmount: 50_000n,
  }

  beforeEach(() => {
    getQuote.mockResolvedValue(onrampQuote())
    createOrder.mockResolvedValue(onrampOrder())
    registerTx.mockResolvedValue({ onramp: { txid: SIGNED_TXID } })
  })

  test('signs the deposit payment, hands it to register-tx and returns the order', async () => {
    const account = new DummyBtcAccount()
    const sw = new GatewaySwidge(account as never, { fromChain: 'bitcoin', client })

    const result = await sw.swidge(ONRAMP)

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
    expect(createOrder).toHaveBeenCalledWith({ onramp: onrampQuote().onramp })
    // The amount comes from the quote: the onramp create-order response carries none.
    expect(account.signTransaction).toHaveBeenCalledWith({
      to: DEPOSIT_ADDRESS,
      value: 50_000n,
      feeRate: undefined,
    })
    expect(registerTx).toHaveBeenCalledWith({
      onramp: { order_id: 'order-onramp', bitcoin_tx_hex: SIGNED_TX_HEX },
    })
    expect(result).toEqual({
      id: 'order-onramp',
      hash: SIGNED_TXID,
      fees: [
        {
          type: 'network',
          amount: 373n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Solver fee',
        },
        {
          type: 'network',
          amount: 195_982n,
          token: USDT_ETHEREUM,
          chain: 'ethereum',
          included: true,
          description: 'Destination-chain execution fee',
        },
      ],
      transactions: [{ hash: SIGNED_TXID, chain: 'bitcoin', type: 'source' }],
      fromTokenAmount: 50_000n,
      toTokenAmount: 37_141_289n,
      toTokenAmountMin: 36_955_582n,
    })
  })

  test('passes config.feeRate to the signer', async () => {
    const account = new DummyBtcAccount()
    const sw = new GatewaySwidge(account as never, { fromChain: 'bitcoin', feeRate: 12, client })

    await sw.swidge(ONRAMP)

    expect(account.signTransaction).toHaveBeenCalledWith({
      to: DEPOSIT_ADDRESS,
      value: 50_000n,
      feeRate: 12,
    })
  })

  // register-tx IS the broadcast, and a failure can follow one that went out: never claim "not sent".
  test('a register-tx failure throws without claiming the transaction was not sent', async () => {
    registerTx.mockRejectedValue(new Error('network error'))
    const sw = new GatewaySwidge(new DummyBtcAccount() as never, { fromChain: 'bitcoin', client })

    await expect(sw.swidge(ONRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.HTTP,
        `register-tx failed for order order-onramp: bitcoin transaction ${SIGNED_TXID} may or ` +
          'may not have been broadcast — check the chain before resending'
      )
    )
  })

  test.each([
    ['another txid', { onramp: { txid: 'ff'.repeat(32) } }, 'ff'.repeat(32)],
    ['no txid', {}, 'undefined'],
  ])('refuses a register-tx response with %s', async (_label, response, reported) => {
    registerTx.mockResolvedValue(response)
    const sw = new GatewaySwidge(new DummyBtcAccount() as never, { fromChain: 'bitcoin', client })

    await expect(sw.swidge(ONRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.HTTP,
        `register-tx reported txid ${reported} for order order-onramp, expected ${SIGNED_TXID}`
      )
    )
  })

  test.each([
    [
      'a testnet address',
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      'order deposit address is not a Bitcoin mainnet address: ' +
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    ],
    [
      'no address',
      'not-an-address',
      'order deposit address is not a Bitcoin mainnet address: not-an-address',
    ],
  ])('refuses a deposit address that is %s before signing', async (_label, address, message) => {
    createOrder.mockResolvedValue({ onramp: { order_id: 'order-onramp', address } })
    const account = new DummyBtcAccount()
    const sw = new GatewaySwidge(account as never, { fromChain: 'bitcoin', client })

    await expect(sw.swidge(ONRAMP)).rejects.toMatchObject(gatewayError(ERR.VALIDATION, message))
    expect(account.signTransaction).not.toHaveBeenCalled()
    expect(registerTx).not.toHaveBeenCalled()
  })

  test('accepts the register-tx txid in upper case and with an 0x prefix', async () => {
    registerTx.mockResolvedValue({ onramp: { txid: `0x${SIGNED_TXID.toUpperCase()}` } })
    const sw = new GatewaySwidge(new DummyBtcAccount() as never, { fromChain: 'bitcoin', client })

    const { hash } = await sw.swidge(ONRAMP)

    expect(hash).toBe(SIGNED_TXID)
  })

  test('refuses before quoting when no refund address resolves', async () => {
    // Can sign, but has no getAddress() to fall back to for the refund address.
    const sw = new GatewaySwidge({ signTransaction: vi.fn() } as never, {
      fromChain: 'bitcoin',
      client,
    })

    await expect(sw.swidge(ONRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.VALIDATION,
        'refundAddress required: pass options.refundAddress or config.refundAddress, or use an ' +
          'account with getAddress()'
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
  })
})

describe('swidge: EVM source', () => {
  const OFFRAMP = {
    fromToken: USDT_BASE,
    toToken: 'BTC',
    toChain: 'bitcoin',
    recipient: 'bc1qrcpt',
    fromTokenAmount: 100_000_000n,
  }
  const ORDER_TX = { to: ALLOWANCE_HOLDER, data: EXEC_100_USDT_BASE, value: '0' }

  class DummyEvmAccount {
    isErc4337 = false
    sendTransaction = vi.fn(async () => ({ hash: '0xtxhash' }))
    async getAddress() {
      return '0xsender'
    }
  }

  /** Detected by class name when the `isErc4337` flag is absent. */
  class WalletAccountEvmErc4337 {
    sendTransaction = vi.fn(async () => ({ hash: '0xuserop' }))
    async getAddress() {
      return '0xsender'
    }
  }

  beforeEach(() => {
    getQuote.mockResolvedValue(offrampQuote())
    createOrder.mockResolvedValue(offrampOrder())
  })

  test('an EOA sends the order tx as-is; V4 indexes it from chain, so nothing is registered', async () => {
    const account = new DummyEvmAccount()
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const { hash } = await sw.swidge(OFFRAMP)

    expect(account.sendTransaction).toHaveBeenCalledWith(ORDER_TX)
    expect(registerTx).not.toHaveBeenCalled()
    expect(hash).toBe('0xtxhash')
  })

  test.each([
    ['no paymaster', {}, {}, undefined],
    ['the instance paymaster', { paymasterToken: '0xpm' }, {}, { paymasterToken: '0xpm' }],
    [
      'a per-call paymaster over the instance one',
      { paymasterToken: '0xpm' },
      { paymasterToken: '0xcall' },
      { paymasterToken: '0xcall' },
    ],
  ])('an ERC-4337 account sends [tx] with %s', async (_label, config, callConfig, aaConfig) => {
    const account = new DummyEvmAccount()
    account.isErc4337 = true
    account.sendTransaction.mockResolvedValue({ hash: '0xuserop' })
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client, ...config })

    const { hash } = await sw.swidge(OFFRAMP, callConfig)

    expect(account.sendTransaction).toHaveBeenCalledWith([ORDER_TX], aaConfig)
    expect(hash).toBe('0xuserop')
  })

  test('an account whose class is WalletAccountEvmErc4337 sends [tx] too', async () => {
    const account = new WalletAccountEvmErc4337()
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    await sw.swidge(OFFRAMP)

    expect(account.sendTransaction).toHaveBeenCalledWith([ORDER_TX], undefined)
  })

  test.each([
    [
      'no order id',
      { offramp: { tx: ORDER_TX } },
      ERR.HTTP,
      'create-order missing offramp.orderId',
    ],
    ['no offramp key', {}, ERR.HTTP, 'create-order missing offramp.orderId'],
    ['no tx', { offramp: { order_id: 'o' } }, ERR.HTTP, 'create-order missing offramp.tx'],
    [
      // An unknown tx type must not be mis-signed as EVM.
      'a solana tx',
      { offramp: { order_id: 'o', tx: { type: 'solana', to: 'Sol1', data: '', value: '0' } } },
      ERR.NOT_SUPPORTED,
      "order tx type 'solana' is not supported",
    ],
    [
      'a tron tx on an EVM route',
      { offramp: { order_id: 'o', tx: { type: 'tron', ...ORDER_TX } } },
      ERR.VALIDATION,
      'create-order returned a tron transaction for a evm route',
    ],
  ])(
    'refuses a create-order response with %s, before signing',
    async (_l, order, code, message) => {
      createOrder.mockResolvedValue(order)
      const account = new DummyEvmAccount()
      const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

      await expect(sw.swidge(OFFRAMP)).rejects.toMatchObject(gatewayError(code, message))
      expect(account.sendTransaction).not.toHaveBeenCalled()
    }
  )

  // The adapter is chosen by route and the payload branch by tx.type: the two must agree.
  test('refuses an untyped (EVM) order tx on a Tron route, before signing', async () => {
    getQuote.mockResolvedValue(tronOfframpQuote())
    createOrder.mockResolvedValue({ offramp: { order_id: 'o', tx: ORDER_TX } })
    const account = { getAddress: async () => OWNER, sendTransaction: vi.fn() }
    const sw = new GatewaySwidge(account as never, { fromChain: 'tron', client })

    await expect(
      sw.swidge({
        fromToken: USDT,
        toToken: 'BTC',
        toChain: 'bitcoin',
        recipient: BTC_RECIPIENT,
        fromTokenAmount: 50_000_000n,
      })
    ).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, 'create-order returned a evm transaction for a tron route')
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })
})

// Attribution is revenue-bearing: gateway-wdk volume is credited to BOB (at 0 fee) purely by this
// token riding on every request. Dropping the default would keep every other test green while
// silently un-attributing all WDK volume, so pin the exact value that goes on the wire.
describe('attribution', () => {
  const request = vi.fn()
  const QUOTE_URL = 'https://gateway-api-mainnet.gobob.xyz/v4/get-quote'
  const QUERY = {
    srcChain: 'bitcoin',
    dstChain: 'base',
    srcToken: ZERO,
    dstToken: USDT_BASE,
    amount: '50000',
    recipient: EVM_RECIPIENT,
    sender: BTC_SENDER,
    refundAddress: BTC_SENDER,
  }
  const account = { getAddress: async () => BTC_SENDER }
  const ONRAMP = {
    fromToken: 'BTC',
    toToken: USDT_BASE,
    toChain: 'base',
    recipient: EVM_RECIPIENT,
    fromTokenAmount: 50_000n,
  }

  beforeEach(() => {
    request.mockResolvedValue({ status: 200, body: onrampQuote() })
  })

  test('with no bearerToken configured, requests carry BOB’s attribution key', async () => {
    const sw = new GatewaySwidge(account as never, { fromChain: 'bitcoin', http: { request } })

    await sw.quoteSwidge(ONRAMP)

    expect(request).toHaveBeenCalledWith('GET', QUOTE_URL, {
      query: QUERY,
      body: undefined,
      headers: { authorization: `Bearer ${BOB_BEARER_TOKEN}` },
    })
  })

  test('an explicit bearerToken overrides the default (direct API agreements)', async () => {
    const sw = new GatewaySwidge(account as never, {
      fromChain: 'bitcoin',
      bearerToken: 'dummy-bearer-token',
      http: { request },
    })

    await sw.quoteSwidge(ONRAMP)

    expect(request).toHaveBeenCalledWith('GET', QUOTE_URL, {
      query: QUERY,
      body: undefined,
      headers: { authorization: 'Bearer dummy-bearer-token' },
    })
  })
})

// simulateSwidge() on Bitcoin and EVM source routes: everything swidge() does short of
// broadcasting. Tron routes are covered in tron.test.ts.
import { beforeEach, describe, test, expect, vi } from 'vitest'
import { AccountRequiredError, ERR, GatewaySwidge } from '../src/index.js'
import type { GatewayClient } from '../src/index.js'
import { gatewayError } from './helpers.js'
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
import {
  OVERPAYING_TXID,
  OVERPAYING_TX_HEX,
  SIGNED_TXID,
  SIGNED_TX_HEX,
  UNDERPAYING_TXID,
  UNDERPAYING_TX_HEX,
} from './fixtures/bitcoin.js'
import { execData } from './fixtures/exec.js'

const getQuote = vi.fn()
const createOrder = vi.fn()
const registerTx = vi.fn()
const client = { getQuote, createOrder, registerTx } as unknown as GatewayClient

const MAX_UINT256 = 2n ** 256n - 1n

beforeEach(() => {
  vi.resetAllMocks()
})

describe('simulateSwidge: onramp', () => {
  class DummyBtcAccount {
    signTransaction = vi.fn()
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

  /** `SwidgeQuote` for `onrampQuote()`: 37141289 × (1 − 50 bps) = 36955582. */
  const SWIDGE_QUOTE = {
    fromTokenAmount: 50_000n,
    toTokenAmount: 37_141_289n,
    toTokenAmountMin: 36_955_582n,
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
    estimatedDuration: 616,
    priceImpact: -0.0002,
    affiliateApplied: false,
  }

  beforeEach(() => {
    getQuote.mockResolvedValue(onrampQuote())
    createOrder.mockResolvedValue(onrampOrder())
  })

  // DEPOSIT_ADDRESS is taproot (P2TR), and checking what the signed tx pays to it needs an ECC
  // library registered with bitcoinjs-lib. The module registers its own: wdk-wallet-btc used to do
  // it for us while both shared one bitcoinjs-lib copy, until its move to bitcoinjs-lib 7 split the
  // copies. This file deliberately loads no wdk-wallet package, so this test fails if ours stops.
  test('signs the deposit payment without handing it to register-tx', async () => {
    const account = new DummyBtcAccount()
    account.signTransaction.mockResolvedValue(SIGNED_TX_HEX)
    const sw = new GatewaySwidge(account as never, { fromChain: 'bitcoin', client })

    const result = await sw.simulateSwidge(ONRAMP)

    expect(createOrder).toHaveBeenCalledWith({ onramp: onrampQuote().onramp })
    expect(account.signTransaction).toHaveBeenCalledWith({
      to: DEPOSIT_ADDRESS,
      value: 50_000n,
      feeRate: undefined,
    })
    expect(registerTx).not.toHaveBeenCalled()
    expect(result).toEqual({
      variant: 'onramp',
      orderId: 'order-onramp',
      quote: SWIDGE_QUOTE,
      broadcast: false,
      // No signedTxHex: it pays a real order's deposit address, so it must not leak from a dry run.
      onramp: { txid: SIGNED_TXID, valid: true, paidToDeposit: 50_000n },
    })
  })

  test.each([
    ['underpays', UNDERPAYING_TX_HEX, UNDERPAYING_TXID, 49_999n],
    ['overpays', OVERPAYING_TX_HEX, OVERPAYING_TXID, 50_001n],
  ])(
    'a signed transaction that %s the deposit address is not valid',
    async (_label, signedTxHex, txid, paidToDeposit) => {
      const account = new DummyBtcAccount()
      account.signTransaction.mockResolvedValue(signedTxHex)
      const sw = new GatewaySwidge(account as never, { fromChain: 'bitcoin', client })

      const { onramp } = (await sw.simulateSwidge(ONRAMP)) as { onramp: unknown }

      expect(onramp).toEqual({ txid, valid: false, paidToDeposit })
    }
  )

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

    await expect(sw.simulateSwidge(ONRAMP)).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, message)
    )
    expect(account.signTransaction).not.toHaveBeenCalled()
  })

  test('an account that cannot sign is refused before any gateway call', async () => {
    const sw = new GatewaySwidge({ getAddress: async () => BTC_SENDER } as never, {
      fromChain: 'bitcoin',
      client,
    })

    await expect(sw.simulateSwidge(ONRAMP)).rejects.toThrow(
      new AccountRequiredError(
        'simulateSwidge() needs an account that implements signTransaction()'
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
  })
})

describe('simulateSwidge: EVM offramp', () => {
  class DummyEvmAccount {
    getAllowance = vi.fn()
    quoteSendTransaction: ReturnType<typeof vi.fn> | undefined = vi.fn()
    sendTransaction = vi.fn()
    async getAddress() {
      return '0xsender'
    }
  }

  const OFFRAMP = {
    fromToken: USDT_BASE,
    toToken: 'BTC',
    toChain: 'bitcoin',
    recipient: 'bc1qrcpt',
    fromTokenAmount: 100_000_000n,
  }
  const ORDER_TX = { to: ALLOWANCE_HOLDER, data: EXEC_100_USDT_BASE, value: '0' }
  const APPROVAL = { token: USDT_BASE, spender: ALLOWANCE_HOLDER, amount: MAX_UINT256 }

  /** `SwidgeQuote` for `offrampQuote()`: 133315 × (1 − 50 bps) = 132648. */
  const SWIDGE_QUOTE = {
    fromTokenAmount: 100_000_000n,
    toTokenAmount: 133_315n,
    toTokenAmountMin: 132_648n,
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
    estimatedDuration: 648,
    priceImpact: -0.0045,
    affiliateApplied: false,
  }

  beforeEach(() => {
    getQuote.mockResolvedValue(offrampQuote())
    createOrder.mockResolvedValue(offrampOrder())
  })

  test('quotes the order tx without sending it, and needs no approval once the allowance covers it', async () => {
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(100_000_000n)
    account.quoteSendTransaction!.mockResolvedValue({ fee: 21_000n })
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const result = await sw.simulateSwidge(OFFRAMP)

    expect(account.getAllowance).toHaveBeenCalledWith(USDT_BASE, ALLOWANCE_HOLDER)
    expect(account.quoteSendTransaction).toHaveBeenCalledWith(ORDER_TX)
    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(registerTx).not.toHaveBeenCalled()
    expect(result).toEqual({
      variant: 'offramp',
      orderId: 'order-offramp',
      quote: SWIDGE_QUOTE,
      broadcast: false,
      evm: { tx: ORDER_TX, gasEstimate: 21_000n, requiredApproval: null, valid: true },
    })
  })

  test('reports the approval still due when the allowance falls short', async () => {
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(50n)
    account.quoteSendTransaction!.mockResolvedValue({ fee: 21_000n })
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const { evm } = (await sw.simulateSwidge(OFFRAMP)) as { evm: unknown }

    expect(evm).toEqual({
      tx: ORDER_TX,
      gasEstimate: 21_000n,
      requiredApproval: APPROVAL,
      valid: true,
    })
  })

  test('a reverting quote is valid: false with the reason, not a throw', async () => {
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(0n)
    account.quoteSendTransaction!.mockRejectedValue(
      new Error('execution reverted: insufficient allowance')
    )
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const { evm } = (await sw.simulateSwidge(OFFRAMP)) as { evm: unknown }

    expect(evm).toEqual({
      tx: ORDER_TX,
      gasEstimate: null,
      requiredApproval: APPROVAL,
      valid: false,
      reason: 'execution reverted: insufficient allowance',
    })
  })

  test('a failing allowance read is valid: false with the reason, before quoting', async () => {
    const account = new DummyEvmAccount()
    account.getAllowance.mockRejectedValue(new Error('node unreachable'))
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const { evm } = (await sw.simulateSwidge(OFFRAMP)) as { evm: unknown }

    expect(account.quoteSendTransaction).not.toHaveBeenCalled()
    expect(evm).toEqual({
      tx: ORDER_TX,
      gasEstimate: null,
      requiredApproval: null,
      valid: false,
      reason: 'node unreachable',
    })
  })

  test('an account without quoteSendTransaction is refused before any gateway call', async () => {
    const account = new DummyEvmAccount()
    account.quoteSendTransaction = undefined
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    await expect(sw.simulateSwidge(OFFRAMP)).rejects.toThrow(
      new AccountRequiredError(
        'simulateSwidge() needs an account that implements quoteSendTransaction()'
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
  })

  test('no account is refused before any gateway call', async () => {
    const sw = new GatewaySwidge(undefined, { fromChain: 'base', client })

    await expect(sw.simulateSwidge(OFFRAMP)).rejects.toThrow(
      new AccountRequiredError(
        'simulateSwidge() needs an account that implements quoteSendTransaction()'
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
  })

  test('carries a USDT-on-Ethereum allowance reset through to the approval', async () => {
    const quote = offrampQuote()
    quote.offramp.srcChain = 'ethereum'
    quote.offramp.inputAmount.chain = 'ethereum'
    quote.offramp.inputAmount.address = USDT_ETHEREUM
    quote.offramp.tokenAddress = USDT_ETHEREUM
    getQuote.mockResolvedValue(quote)
    const order = offrampOrder()
    const tx = { ...ORDER_TX, data: execData({ token: USDT_ETHEREUM, amount: 100_000_000n }) }
    order.offramp.tx = { ...order.offramp.tx, ...tx, chain: 'ethereum' }
    createOrder.mockResolvedValue(order)
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(100n)
    account.quoteSendTransaction!.mockResolvedValue({ fee: 21_000n })
    const sw = new GatewaySwidge(account as never, { fromChain: 'ethereum', client })

    const { evm } = (await sw.simulateSwidge({ ...OFFRAMP, fromToken: USDT_ETHEREUM })) as {
      evm: unknown
    }

    expect(evm).toEqual({
      tx,
      gasEstimate: 21_000n,
      requiredApproval: {
        token: USDT_ETHEREUM,
        spender: ALLOWANCE_HOLDER,
        amount: MAX_UINT256,
        resetRequired: true,
      },
      valid: true,
    })
  })
})

// getRequiredApproval() on EVM source routes. Approvals are unbounded (MAX_UINT256), so the
// spender is checked against a hardcoded per-chain AllowanceHolder table, never trusted from the
// create-order response. Tron routes are covered in tron.test.ts.
import { beforeEach, describe, test, expect, vi } from 'vitest'
import { ERR, GatewaySwidge } from '../src/index.js'
import type { GatewayClient } from '../src/index.js'
import { gatewayError } from './helpers.js'
import {
  ALLOWANCE_HOLDER,
  USDT_BASE,
  USDT_ETHEREUM,
  ZERO,
  offrampOrder,
  offrampQuote,
} from './fixtures/gateway.js'

const getQuote = vi.fn()
const createOrder = vi.fn()
const client = { getQuote, createOrder } as unknown as GatewayClient

const MAX_UINT256 = 2n ** 256n - 1n
/** The Gateway's self-deployed AllowanceHolder, on chains without 0x's canonical one (BOB). */
const SELF_DEPLOYED = '0x8fd545b348e84deb145f0179a00c671f0b9519c3'
const EVIL = '0x000000000000000000000000000000000000bEEF'

const OFFRAMP = {
  fromToken: USDT_BASE,
  toToken: 'BTC',
  toChain: 'bitcoin',
  recipient: 'bc1qrcpt',
  fromTokenAmount: 100_000_000n,
}

class DummyEvmAccount {
  getAllowance = vi.fn()
  quoteSendTransaction = vi.fn()
  async getAddress() {
    return '0xsender'
  }
}

/** The live offramp quote, re-pointed at `chain` and `token`. */
function quoteOn(chain: string, token = USDT_BASE) {
  const quote = offrampQuote()
  quote.offramp.srcChain = chain
  quote.offramp.inputAmount.chain = chain
  quote.offramp.inputAmount.address = token
  return quote
}

/** An offramp create-order response whose order tx targets `to`. */
function orderTo(to: string) {
  const order = offrampOrder()
  order.offramp.tx.to = to
  return order
}

beforeEach(() => {
  vi.resetAllMocks()
  getQuote.mockResolvedValue(offrampQuote())
  createOrder.mockResolvedValue(offrampOrder())
})

describe('getRequiredApproval', () => {
  test('returns an unbounded approval to the AllowanceHolder when the allowance falls short', async () => {
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(100n)
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const approval = await sw.getRequiredApproval(OFFRAMP)

    expect(createOrder).toHaveBeenCalledWith({ offramp: offrampQuote().offramp })
    expect(account.getAllowance).toHaveBeenCalledWith(USDT_BASE, ALLOWANCE_HOLDER)
    expect(approval).toEqual({ token: USDT_BASE, spender: ALLOWANCE_HOLDER, amount: MAX_UINT256 })
  })

  test.each([
    // Chain ids and spender addresses both compare case-insensitively.
    ['ETHEREUM', ALLOWANCE_HOLDER.toLowerCase()],
    ['bob', SELF_DEPLOYED],
  ])('accepts the %s AllowanceHolder %s', async (chain, spender) => {
    getQuote.mockResolvedValue(quoteOn(chain))
    createOrder.mockResolvedValue(orderTo(spender))
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(0n)
    const sw = new GatewaySwidge(account as never, { fromChain: chain, client })

    const approval = await sw.getRequiredApproval(OFFRAMP)

    expect(approval).toEqual({ token: USDT_BASE, spender, amount: MAX_UINT256 })
  })

  test.each([
    ['base', SELF_DEPLOYED, ALLOWANCE_HOLDER.toLowerCase()],
    ['bob', ALLOWANCE_HOLDER, SELF_DEPLOYED],
    ['base', 'not-an-address', ALLOWANCE_HOLDER.toLowerCase()],
  ])('refuses %s spender %s', async (chain, spender, expected) => {
    getQuote.mockResolvedValue(quoteOn(chain))
    createOrder.mockResolvedValue(orderTo(spender))
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(0n)
    const sw = new GatewaySwidge(account as never, { fromChain: chain, client })

    await expect(sw.getRequiredApproval(OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.VALIDATION,
        `refusing to approve ${spender} on chain "${chain}": expected the AllowanceHolder at ${expected}`
      )
    )
  })

  test('refuses on a chain with no known AllowanceHolder', async () => {
    getQuote.mockResolvedValue(quoteOn('sei'))
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(0n)
    const sw = new GatewaySwidge(account as never, { fromChain: 'sei', client })

    await expect(sw.getRequiredApproval(OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.VALIDATION,
        `refusing to approve ${ALLOWANCE_HOLDER}: no known AllowanceHolder for chain "sei" ` +
          '(known: bob, tron, ethereum, base, bsc, arbitrum, avalanche, unichain, plasma, ' +
          'polygon, hyperevm, hyperliquid, robinhood)'
      )
    )
  })

  test('returns null when the allowance already covers the order — no spender check is due', async () => {
    createOrder.mockResolvedValue(orderTo(EVIL))
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(100_000_000n)
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const approval = await sw.getRequiredApproval(OFFRAMP)

    expect(account.getAllowance).toHaveBeenCalledWith(USDT_BASE, EVIL)
    expect(approval).toBe(null)
  })

  // USDT on Ethereum cannot move between two non-zero allowances.
  test.each([
    ['a stale non-zero allowance of USDT on Ethereum', 'ethereum', USDT_ETHEREUM, 100n, true],
    ['a zero allowance', 'ethereum', USDT_ETHEREUM, 0n, false],
    ['the same token address on another chain', 'base', USDT_ETHEREUM, 100n, false],
    ['another token on Ethereum', 'ethereum', USDT_BASE, 100n, false],
  ])('flags resetRequired only for %s', async (_label, chain, token, allowance, reset) => {
    getQuote.mockResolvedValue(quoteOn(chain, token))
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(allowance)
    const sw = new GatewaySwidge(account as never, { fromChain: chain, client })

    const approval = await sw.getRequiredApproval({ ...OFFRAMP, fromToken: token })

    expect(approval).toEqual({
      token,
      spender: ALLOWANCE_HOLDER,
      amount: MAX_UINT256,
      ...(reset ? { resetRequired: true } : {}),
    })
  })

  test('returns null for the native token, without an allowance read', async () => {
    getQuote.mockResolvedValue(quoteOn('base', ZERO))
    const account = new DummyEvmAccount()
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    const approval = await sw.getRequiredApproval({ ...OFFRAMP, fromToken: ZERO })

    expect(approval).toBe(null)
    expect(account.getAllowance).not.toHaveBeenCalled()
  })

  test('creates an order once per route to find the spender, then reuses it', async () => {
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(0n)
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })
    const APPROVAL = { token: USDT_BASE, spender: ALLOWANCE_HOLDER, amount: MAX_UINT256 }

    const first = await sw.getRequiredApproval(OFFRAMP)
    const second = await sw.getRequiredApproval(OFFRAMP)

    expect(createOrder.mock.calls).toEqual([[{ offramp: offrampQuote().offramp }]])
    expect([first, second]).toEqual([APPROVAL, APPROVAL])
  })

  test('returns null for an onramp, without quoting or creating an order', async () => {
    const sw = new GatewaySwidge({ getAddress: async () => 'bc1qsender' } as never, {
      fromChain: 'bitcoin',
      client,
    })

    const approval = await sw.getRequiredApproval({
      fromToken: 'BTC',
      toToken: USDT_BASE,
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: 100_000n,
    })

    expect(approval).toBe(null)
    expect(getQuote).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
  })
})

describe('simulateSwidge', () => {
  test('refuses to report an approval to a spender that is not the AllowanceHolder', async () => {
    createOrder.mockResolvedValue(orderTo(EVIL))
    const account = new DummyEvmAccount()
    account.getAllowance.mockResolvedValue(0n)
    account.quoteSendTransaction.mockResolvedValue({ fee: 1n })
    const sw = new GatewaySwidge(account as never, { fromChain: 'base', client })

    await expect(sw.simulateSwidge(OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.VALIDATION,
        `refusing to approve ${EVIL} on chain "base": expected the AllowanceHolder at ` +
          ALLOWANCE_HOLDER.toLowerCase()
      )
    )
  })
})

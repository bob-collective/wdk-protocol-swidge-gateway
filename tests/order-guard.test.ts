// The create-order tx is held against the request before anything signs (src/order-guard.ts).
import { describe, test, expect, vi } from 'vitest'
import { Interface, id } from 'ethers'
import { Transaction } from 'bitcoinjs-lib'
import { GatewaySwidge } from '../src/gateway-swidge.js'
import type { GatewaySwidgeConfig } from '../src/gateway-swidge.js'
import type { GatewayClient } from '../src/gateway-client.js'
import { EXEC_SELECTOR } from '../src/order-guard.js'
import { CANONICAL_HOLDER, EVM_TOKEN, ROUTER, execData } from './fixtures/exec.js'
import { REGISTRY as TRON_HOLDER, USDT as USDT_TRON } from './fixtures/tron.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const AMOUNT = 1_000_000n
const BASE_DEFAULT_CAP = 5n * 10n ** 15n // 0.005 ETH

type OrderTx = {
  type?: string
  to: string
  data: string
  value: string
  feeLimit?: string
  chain?: string
}

function setup(tx: OrderTx, config: GatewaySwidgeConfig = {}, fromChain = 'base') {
  const client = {
    getQuote: vi.fn(async () => ({
      offramp: {
        inputAmount: { amount: String(AMOUNT) },
        outputAmount: { amount: '1300' },
        srcChain: fromChain,
      },
    })),
    createOrder: vi.fn(async () => ({ offramp: { order_id: 'o', tx } })),
    registerTx: vi.fn(),
  }
  const account = {
    getAddress: vi.fn(async () => (fromChain === 'tron' ? 'TSender' : '0xsender')),
    sendTransaction: vi.fn(async () => ({ hash: '0xtxhash' })),
  }
  const sw = new GatewaySwidge(account, {
    fromChain,
    client: client as unknown as GatewayClient,
    ...config,
  })
  return { sw, client, account }
}

const route = (fromToken = EVM_TOKEN, fromTokenAmount = AMOUNT) => ({
  fromToken,
  toToken: 'BTC',
  toChain: 'bitcoin',
  recipient: 'bc1qrcpt',
  fromTokenAmount,
})

const order = (over: Partial<OrderTx> & { token?: string; amount?: bigint } = {}): OrderTx => {
  const { token = EVM_TOKEN, amount = AMOUNT, ...tx } = over
  return {
    to: CANONICAL_HOLDER,
    data: execData({ token, amount }),
    value: '0',
    chain: 'base',
    ...tx,
  }
}

async function refused(
  tx: OrderTx,
  message: string | RegExp,
  opts: Parameters<typeof setup>[1] = {}
) {
  const { sw, account } = setup(tx, opts)
  await expect(sw.swidge(route())).rejects.toThrow(message)
  expect(account.sendTransaction).not.toHaveBeenCalled()
}

describe('exec calldata', () => {
  test('selector and encoding match the ABI', () => {
    const iface = new Interface([
      'function exec(address operator, address token, uint256 amount, address target, bytes data)',
    ])
    expect(id('exec(address,address,uint256,address,bytes)').slice(2, 10)).toBe(EXEC_SELECTOR)
    expect(execData({ token: EVM_TOKEN, amount: AMOUNT, inner: '0x0102' })).toBe(
      iface.encodeFunctionData('exec', [ROUTER, EVM_TOKEN, AMOUNT, ROUTER, '0x0102'])
    )
  })
})

describe('EVM order tx', () => {
  test('a matching exec call on the pinned AllowanceHolder is signed as-is', async () => {
    const tx = order()
    const { sw, account } = setup(tx)
    expect((await sw.swidge(route())).hash).toBe('0xtxhash')
    expect(account.sendTransaction).toHaveBeenCalledWith({ to: tx.to, data: tx.data, value: '0' })
  })

  test('another contract is refused', async () => {
    await refused(
      order({ to: '0x000000000000000000000000000000000000dEaD' }),
      'refusing to sign the order: order tx targets 0x000000000000000000000000000000000000dEaD, ' +
        'expected the AllowanceHolder at 0x0000000000001ff3684f28c67538d4d072c22734'
    )
  })

  test('another AllowanceHolder function is refused', async () => {
    // transferFrom(address,address,address,uint256) on the same contract
    const data = '0x15dacbea' + '0'.repeat(64 * 6)
    await refused(order({ data }), 'order calldata selector 0x15dacbea is not exec (0x2213bc0b)')
  })

  test('another token is refused', async () => {
    const usdt = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
    await refused(
      order({ token: usdt }),
      `order moves token ${usdt.toLowerCase()}, but the swidge is from ${EVM_TOKEN.toLowerCase()}`
    )
  })

  test('more than fromTokenAmount is refused; up to it is fine', async () => {
    await refused(
      order({ amount: AMOUNT + 1n }),
      `order moves ${AMOUNT + 1n} of the source token, more than fromTokenAmount ${AMOUNT}`
    )
    const { sw } = setup(order({ amount: AMOUNT - 1n }))
    await expect(sw.swidge(route())).resolves.toMatchObject({ hash: '0xtxhash' })
  })

  test('a dirty address word is refused', async () => {
    const clean = order().data
    const dirty = clean.slice(0, 10 + 64) + 'ff' + clean.slice(10 + 64 + 2)
    await refused(order({ data: dirty }), 'exec token is not a clean address word')
  })

  test('trailing bytes or a non-canonical bytes offset are refused', async () => {
    await refused(
      order({ data: order().data + '00'.repeat(32) }),
      'order calldata is not a canonically encoded exec call'
    )
    const data = order().data
    const offsetAt = 10 + 64 * 4
    const moved = data.slice(0, offsetAt) + 'c0'.padStart(64, '0') + data.slice(offsetAt + 64)
    await refused(order({ data: moved }), 'order calldata is not a canonically encoded exec call')
  })
})

describe('order provenance and encoding', () => {
  test('an order built for another chain is refused', async () => {
    await refused(
      order({ chain: 'arbitrum' }),
      'order tx is for chain arbitrum, but the route is from base'
    )
    await refused(order({ chain: undefined }), 'order tx is for chain undefined')
  })

  test('a quote without srcChain is refused before create-order', async () => {
    const { sw, client } = setup(order())
    client.getQuote.mockResolvedValueOnce({
      offramp: { inputAmount: { amount: String(AMOUNT) }, outputAmount: { amount: '1300' } },
    } as never)
    await expect(sw.swidge(route())).rejects.toThrow(
      'quote is for source chain undefined, but the route was requested from base'
    )
    expect(client.createOrder).not.toHaveBeenCalled()
  })

  test('an EVM `to` must be 0x hex, not the holder in Tron 41-hex form', async () => {
    await refused(
      order({ to: '41' + CANONICAL_HOLDER.slice(2) }),
      /order tx targets 410000000000001fF3684f28c67538d4D072C22734/
    )
  })

  test.each([['0x10'], [''], [' 1'], ['1e3'], ['-1']])(
    'a value of %j is refused, not reinterpreted',
    async (value) => {
      await refused(
        order({ value }),
        `order tx value ${JSON.stringify(value)} is not a decimal integer`
      )
    }
  )
})

describe('native value', () => {
  test('an ERC-20 order may carry a messaging fee up to the chain default', async () => {
    const { sw } = setup(order({ value: String(BASE_DEFAULT_CAP) }))
    await expect(sw.swidge(route())).resolves.toMatchObject({ hash: '0xtxhash' })
    await refused(
      order({ value: String(BASE_DEFAULT_CAP + 1n) }),
      `order tx sends ${BASE_DEFAULT_CAP + 1n} native base units on top of the swap, above ` +
        `maxNativeFee ${BASE_DEFAULT_CAP}`
    )
  })

  test('config.maxNativeFee replaces the default; a per-call value overrides it', async () => {
    await refused(order({ value: '1001' }), /above maxNativeFee 1000/, { maxNativeFee: 1000 })
    const { sw } = setup(order({ value: '1001' }), { maxNativeFee: 1000 })
    await expect(sw.swidge(route(), { maxNativeFee: '1001' })).resolves.toMatchObject({
      hash: '0xtxhash',
    })
  })

  test('simulateSwidge and getRequiredApproval take the per-call maxNativeFee too', async () => {
    const { sw, account } = setup(order({ value: '1001' }), { maxNativeFee: 1000 })
    Object.assign(account, {
      getAllowance: vi.fn(async () => 0n),
      quoteSendTransaction: vi.fn(async () => ({ fee: 1n })),
    })
    await expect(sw.simulateSwidge(route())).rejects.toThrow(/above maxNativeFee 1000/)
    await expect(sw.getRequiredApproval(route())).rejects.toThrow(/above maxNativeFee 1000/)

    const perCall = { maxNativeFee: 1001n }
    await expect(sw.simulateSwidge(route(), perCall)).resolves.toMatchObject({
      evm: { valid: true, requiredApproval: { spender: CANONICAL_HOLDER } },
    })
    await expect(sw.getRequiredApproval(route(), perCall)).resolves.toMatchObject({
      spender: CANONICAL_HOLDER,
    })
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('an invalid per-call maxNativeFee is refused before any gateway call', async () => {
    const { sw, client } = setup(order())
    for (const call of [
      () => sw.swidge(route(), { maxNativeFee: -1 }),
      () => sw.simulateSwidge(route(), { maxNativeFee: '0x10' }),
      () => sw.getRequiredApproval(route(), { maxNativeFee: 1.5 }),
    ]) {
      await expect(call()).rejects.toThrow(/maxNativeFee must be a non-negative integer/)
    }
    expect(client.getQuote).not.toHaveBeenCalled()
  })

  test('maxNativeFee: 0 forbids any native value on an ERC-20 order', async () => {
    await refused(order({ value: '1' }), /above maxNativeFee 0/, { maxNativeFee: 0n })
  })

  test('a native source pays its amount as value; only the excess is capped', async () => {
    const native = (value: bigint) => order({ token: ZERO, value: String(value) })
    const ok = setup(native(AMOUNT + BASE_DEFAULT_CAP))
    await expect(ok.sw.swidge(route(ZERO))).resolves.toMatchObject({ hash: '0xtxhash' })

    const over = setup(native(AMOUNT + BASE_DEFAULT_CAP + 1n))
    await expect(over.sw.swidge(route(ZERO))).rejects.toThrow(
      `order tx sends ${BASE_DEFAULT_CAP + 1n} native base units on top of the swap`
    )
    expect(over.account.sendTransaction).not.toHaveBeenCalled()
  })

  test('an invalid maxNativeFee is refused at construction', () => {
    expect(() => setup(order(), { maxNativeFee: -1 })).toThrow(
      'maxNativeFee must be a non-negative integer in base units, got -1'
    )
    expect(() => setup(order(), { maxNativeFee: 1.5 })).toThrow(/maxNativeFee must be/)
    expect(() => setup(order(), { maxNativeFee: '0x10' })).toThrow(/maxNativeFee must be/)
  })
})

describe('Tron order tx', () => {
  const tron = (over: Partial<OrderTx> & { token?: string } = {}) => {
    const { token = USDT_TRON, ...tx } = over
    return {
      type: 'tron',
      to: TRON_HOLDER,
      data: execData({ token, amount: AMOUNT }),
      value: '0',
      chain: 'tron',
      feeLimit: '100000000',
      ...tx,
    }
  }

  test('the Tron AllowanceHolder and a Base58 source token are compared as addresses', async () => {
    const { sw, account } = setup(tron({ to: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax' }), {}, 'tron')
    await expect(sw.swidge(route(USDT_TRON))).rejects.toThrow(
      'order tx targets TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax, expected the AllowanceHolder at ' +
        '0x07a39ae4c49dee86e892450b20881f32cd5d500d'
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('a feeLimit above 100 TRX is refused', async () => {
    const { sw } = setup(tron({ feeLimit: '100000001' }), {}, 'tron')
    await expect(sw.swidge(route(USDT_TRON))).rejects.toThrow(
      'order tx feeLimit 100000001 sun is above 100000000'
    )
  })

  test('callValue above 50 TRX is refused', async () => {
    const { sw } = setup(tron({ value: '50000001' }), {}, 'tron')
    await expect(sw.swidge(route(USDT_TRON))).rejects.toThrow(/above maxNativeFee 50000000/)
  })
})

describe('onramp', () => {
  test('a quote asking for more BTC than fromTokenAmount is refused before signing', async () => {
    const client = {
      getQuote: vi.fn(async () => ({ onramp: { inputAmount: { amount: '100001' } } })),
      createOrder: vi.fn(async () => ({ onramp: { order_id: 'o', address: 'bc1qdeposit' } })),
      registerTx: vi.fn(),
    }
    const signTransaction = vi.fn(async () => new Transaction().toHex())
    const sw = new GatewaySwidge(
      { getAddress: async () => 'bc1qsender', signTransaction },
      { fromChain: 'bitcoin', client: client as unknown as GatewayClient }
    )
    await expect(
      sw.swidge({
        fromToken: 'BTC',
        toToken: EVM_TOKEN,
        toChain: 'base',
        recipient: '0xrcpt',
        fromTokenAmount: 100_000n,
      })
    ).rejects.toThrow(
      'refusing to sign the order: the quote asks for 100001 sats, but fromTokenAmount is 100000'
    )
    expect(signTransaction).not.toHaveBeenCalled()
    expect(client.registerTx).not.toHaveBeenCalled()
  })
})

// Tron source routes, exercised through GatewaySwidge's public API with a fake gateway client
// and a fake tronweb. The account signs a transaction's txID alone and only checks that the owner
// is itself, so most of what is tested here is what the module checks before the signer sees it.
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'
import { AccountRequiredError, ERR, GatewaySwidge, buildTronApproval } from '../src/index.js'
import type { GatewayClient, GatewaySwidgeConfig } from '../src/index.js'
import { gatewayError } from './helpers.js'
import { USDT_ETHEREUM, ZERO } from './fixtures/gateway.js'
import {
  BTC_RECIPIENT,
  OWNER,
  REGISTRY,
  SPENDER,
  TRON_OFFRAMP_EXEC,
  USDT,
  buildTronTx,
  tronOfframpOrder,
  tronOfframpQuote,
} from './fixtures/tron.js'
import { execData } from './fixtures/exec.js'

/** The order calldata as it sits in a built Tron tx's `raw_data` (no `0x`). */
const ORDER_INPUT = TRON_OFFRAMP_EXEC.slice(2)

const { tronWebCtor } = vi.hoisted(() => ({ tronWebCtor: vi.fn() }))
vi.mock('tronweb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tronweb')>()),
  TronWeb: class {
    transactionBuilder = {}
    constructor(config: { fullHost: string }) {
      tronWebCtor(config.fullHost)
    }
  },
}))

const getQuote = vi.fn()
const createOrder = vi.fn()
const registerTx = vi.fn()
const client = { getQuote, createOrder, registerTx } as unknown as GatewayClient

const MAX_UINT256 = 2n ** 256n - 1n
/** Hex form (`41…`) of the Base58Check addresses, as the node's raw_data carries them. */
const OWNER_HEX = '41891cdb91d149f23b1a45d9c5ca78a88d0cb44c18'
const REGISTRY_HEX = '4107a39ae4c49dee86e892450b20881f32cd5d500d'
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'

/** The transaction an honest node builds for `tronOfframpOrder()`, and its id. */
const BUILT_TX = buildTronTx()
const TXID = BUILT_TX.txID

const TRON_OFFRAMP = {
  fromToken: USDT,
  toToken: 'BTC',
  toChain: 'bitcoin',
  recipient: BTC_RECIPIENT,
  fromTokenAmount: 50_000_000n,
}

/** `SwidgeQuote` for `tronOfframpQuote()`: 66086 × (1 − 50 bps) = 65755. */
const SWIDGE_QUOTE = {
  fromTokenAmount: 50_000_000n,
  toTokenAmount: 66_086n,
  toTokenAmountMin: 65_755n,
  fees: [
    {
      type: 'network',
      amount: 498n,
      token: USDT_ETHEREUM,
      chain: 'ethereum',
      included: true,
      description: 'Solver fee',
    },
    {
      type: 'network',
      amount: 660n,
      token: ZERO,
      chain: 'bitcoin',
      included: true,
      description: 'Bitcoin transaction inclusion fee',
    },
  ],
  estimatedDuration: 648,
  priceImpact: -0.004,
  affiliateApplied: false,
}

/** A uint256 as the 32-byte hex word `triggerConstantContract` returns. */
function word(n: bigint): string {
  return n.toString(16).padStart(64, '0')
}

interface BuildOptions {
  input: string
  callValue: number
  feeLimit: number
}

/**
 * A node that honours the call it was asked to build: the response is derived from the
 * arguments, so the pre-signing checks pass unless a test bends it. `trx.getTransaction`
 * answers, i.e. the node accepted what was broadcast. The allowance reads as 0.
 */
class DummyTronWeb {
  transactionBuilder = {
    triggerSmartContract: vi.fn(
      async (
        to: string,
        _selector: string,
        options: BuildOptions,
        _p: unknown[],
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
    triggerConstantContract: vi.fn(async () => ({ constant_result: [word(0n)] })),
  }
  trx: { getTransaction: ReturnType<typeof vi.fn> } | undefined = {
    getTransaction: vi.fn(async (txid: string) => ({ txID: txid })),
  }
}

/** WalletAccountTron's surface: `_tronWeb` is the provider the account broadcasts through. */
class DummyTronAccount {
  sendTransaction = vi.fn(async (tx: { txID: string }) => ({ hash: tx.txID }))
  quoteSendTransaction?: ReturnType<typeof vi.fn>
  constructor(public _tronWeb?: DummyTronWeb) {}
  async getAddress() {
    return OWNER
  }
}

function gatewaySwidge(account: unknown, config: GatewaySwidgeConfig = {}) {
  return new GatewaySwidge(account as never, { fromChain: 'tron', client, ...config })
}

/** A node that ignores the request and answers with `tx` instead. */
function hostile(tx: unknown): DummyTronWeb {
  const tronWeb = new DummyTronWeb()
  tronWeb.transactionBuilder.triggerSmartContract.mockResolvedValue({ transaction: tx })
  return tronWeb
}

beforeEach(() => {
  vi.resetAllMocks()
  getQuote.mockResolvedValue(tronOfframpQuote())
  createOrder.mockResolvedValue(tronOfframpOrder())
})

describe('swidge', () => {
  test('builds the order call from raw calldata, broadcasts it and returns the confirmed txid', async () => {
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)
    const sw = gatewaySwidge(account)

    const result = await sw.swidge(TRON_OFFRAMP)

    expect(getQuote).toHaveBeenCalledWith({
      srcChain: 'tron',
      dstChain: 'bitcoin',
      srcToken: USDT,
      dstToken: ZERO,
      amount: '50000000',
      recipient: BTC_RECIPIENT,
      sender: OWNER,
      refundAddress: OWNER,
    })
    expect(createOrder).toHaveBeenCalledWith({ offramp: tronOfframpQuote().offramp })
    // Empty selector + options.input is the only tronweb path that takes pre-encoded calldata;
    // the 0x prefix is stripped and the amounts passed as integers.
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      REGISTRY,
      '',
      { input: ORDER_INPUT, callValue: 0, feeLimit: 50_000_000 },
      [],
      OWNER
    )
    expect(account.sendTransaction).toHaveBeenCalledWith(BUILT_TX)
    expect(tronWeb.trx!.getTransaction).toHaveBeenCalledWith(TXID)
    expect(registerTx).not.toHaveBeenCalled()
    expect(result).toEqual({
      id: 'order-tron',
      hash: TXID,
      fees: SWIDGE_QUOTE.fees,
      transactions: [{ hash: TXID, chain: 'tron', type: 'source' }],
      fromTokenAmount: 50_000_000n,
      toTokenAmount: 66_086n,
      toTokenAmountMin: 65_755n,
    })
  })

  test('falls back to a 100 TRX fee limit when the order omits one', async () => {
    createOrder.mockResolvedValue(tronOfframpOrder({ feeLimit: undefined }))
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)

    await gatewaySwidge(account).swidge(TRON_OFFRAMP)

    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      REGISTRY,
      '',
      { input: ORDER_INPUT, callValue: 0, feeLimit: 100_000_000 },
      [],
      OWNER
    )
    expect(account.sendTransaction).toHaveBeenCalledWith(buildTronTx({ feeLimit: 100_000_000 }))
  })

  test('config.tronWeb builds the call instead of the account provider', async () => {
    const own = new DummyTronWeb()
    const override = new DummyTronWeb()

    await gatewaySwidge(new DummyTronAccount(own), { tronWeb: override }).swidge(TRON_OFFRAMP)

    expect(override.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      REGISTRY,
      '',
      { input: ORDER_INPUT, callValue: 0, feeLimit: 50_000_000 },
      [],
      OWNER
    )
    expect(own.transactionBuilder.triggerSmartContract).not.toHaveBeenCalled()
  })

  test('throws when no provider can be resolved', async () => {
    const account = new DummyTronAccount()

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.NOT_SUPPORTED,
        'no tron provider available: pass config.tronWeb or config.tronProvider, or use a ' +
          "WalletAccountTron connected to a provider. Neither option replaces the account's " +
          'own provider, which broadcasts'
      )
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('an account that cannot send is refused before any gateway call', async () => {
    const account = { getAddress: async () => OWNER, _tronWeb: new DummyTronWeb() }

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toThrow(
      new AccountRequiredError(
        'swidge() needs a full account that implements sendTransaction(); a read-only account ' +
          'can only quote'
      )
    )
    expect(getQuote).not.toHaveBeenCalled()
  })

  // The order guard refuses these before the adapter's own checks, which stay as a backstop.
  test.each([
    [
      { data: '0x' },
      'refusing to sign the order: order calldata is not an AllowanceHolder exec call',
    ],
    [
      { value: '9007199254740993' },
      'refusing to sign the order: order tx sends 9007199254740993 native base units on top of ' +
        'the swap, above maxNativeFee 50000000',
    ],
  ])('refuses an order tx with %j', async (tx, message) => {
    createOrder.mockResolvedValue(tronOfframpOrder(tx))
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.VALIDATION, message)
    )
    expect(tronWeb.transactionBuilder.triggerSmartContract).not.toHaveBeenCalled()
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('a provider override does not make a disconnected account able to broadcast', async () => {
    // config.tronWeb / config.tronProvider only pick the node that BUILDS the call;
    // WalletAccountTron.sendTransaction still needs its own provider, and says so.
    const account = new DummyTronAccount()
    account.sendTransaction.mockRejectedValue(
      new Error('The wallet must be connected to tron web to send transactions.')
    )

    await expect(
      gatewaySwidge(account, { tronWeb: new DummyTronWeb() }).swidge(TRON_OFFRAMP)
    ).rejects.toThrow(new Error('The wallet must be connected to tron web to send transactions.'))
  })
})

// A node reports failure in the envelope, and can still carry a transaction alongside it.
describe('swidge: a node that rejects the order call', () => {
  test.each([
    ['returns no transaction', {}, 'tron node returned no transaction for the order call'],
    [
      'reports failure alongside a transaction',
      {
        result: { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: 'no such contract' },
        transaction: BUILT_TX,
      },
      'tron node rejected the order call: CONTRACT_VALIDATE_ERROR: no such contract',
    ],
    [
      'answers with a bare result: false',
      { result: false, transaction: BUILT_TX },
      'tron node rejected the order call',
    ],
    [
      'reports a code and message that are not strings',
      { result: { result: false, code: Symbol('code'), message: Symbol('message') } },
      'tron node rejected the order call',
    ],
    [
      'reports a top-level Error',
      { Error: 'class org.tron.core.exception.ContractValidateException', transaction: BUILT_TX },
      'tron node rejected the order call: class org.tron.core.exception.ContractValidateException',
    ],
  ])('%s', async (_label, response, message) => {
    const tronWeb = new DummyTronWeb()
    tronWeb.transactionBuilder.triggerSmartContract.mockResolvedValue(response)
    const account = new DummyTronAccount(tronWeb)

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      gatewayError(ERR.HTTP, message)
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })
})

// A Tron txid exists before the transaction does, so a hash proves nothing was broadcast.
describe('swidge: confirming the broadcast', () => {
  const notKnown = (ms: number) =>
    gatewayError(
      ERR.HTTP,
      `the tron node still does not know transaction ${TXID} ${ms}ms after broadcasting it, so ` +
        'the broadcast was rejected (an unactivated or unfunded sender is the usual cause). ' +
        'Check that txid on chain before sending the same transfer again'
    )

  test('rejects a hash that is not the txID we signed, before looking it up', async () => {
    const foreign = buildTronTx({ data: 'deadbeef' }).txID
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)
    account.sendTransaction.mockResolvedValue({ hash: foreign })

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.HTTP,
        `the tron account broadcast returned hash ${foreign}, but the transaction we built and ` +
          `signed is ${TXID}, so that hash is not ours and must not be returned. Check both ` +
          'txids on chain before sending the same transfer again'
      )
    )
    expect(tronWeb.trx!.getTransaction).not.toHaveBeenCalled()
  })

  test('accepts the same txID in upper case and with an 0x prefix', async () => {
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)
    account.sendTransaction.mockResolvedValue({ hash: `0x${TXID.toUpperCase()}` })

    const { hash } = await gatewaySwidge(account).swidge(TRON_OFFRAMP)

    expect(hash).toBe(TXID)
    expect(tronWeb.trx!.getTransaction).toHaveBeenCalledWith(TXID)
  })

  test('fails immediately when the account comes back without a hash', async () => {
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)
    account.sendTransaction.mockResolvedValue({})

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.HTTP,
        'the tron account returned no transaction hash for the order call, so the node ' +
          'rejected the broadcast (an unactivated or unfunded sender is the usual cause). The ' +
          `transaction we built and signed is ${TXID} — check that on chain before sending the ` +
          'same transfer again'
      )
    )
    expect(tronWeb.trx!.getTransaction).not.toHaveBeenCalled()
  })

  test.each([
    ['raises', async () => Promise.reject(new Error('Transaction not found'))],
    // tronweb raises on an empty body, but a structural config.tronWeb need not raise on anything.
    ['resolves with an empty body', async () => ({})],
    [
      'answers with some other transaction',
      async () => ({ txID: buildTronTx({ data: 'dead' }).txID }),
    ],
  ])('throws when the node never confirms — its lookup %s', async (_label, lookup) => {
    const tronWeb = new DummyTronWeb()
    tronWeb.trx!.getTransaction.mockImplementation(lookup)
    const account = new DummyTronAccount(tronWeb)

    await expect(
      gatewaySwidge(account, { tronConfirmTimeoutMs: 0 }).swidge(TRON_OFFRAMP)
    ).rejects.toMatchObject(notKnown(0))
    // A 0ms window allows exactly one read-back.
    expect(tronWeb.trx!.getTransaction.mock.calls).toEqual([[TXID]])
    expect(registerTx).not.toHaveBeenCalled()
  })

  test.each([
    ['a not-found error', () => Promise.reject(new Error('Transaction not found'))],
    ['an empty body', async () => ({})],
  ])('keeps polling past %s until the node answers with our transaction', async (_l, miss) => {
    const tronWeb = new DummyTronWeb()
    tronWeb
      .trx!.getTransaction.mockImplementationOnce(miss)
      .mockImplementationOnce(miss)
      .mockResolvedValueOnce({ txID: TXID.toUpperCase() })
    const account = new DummyTronAccount(tronWeb)

    const { hash } = await gatewaySwidge(account, { tronConfirmTimeoutMs: 5_000 }).swidge(
      TRON_OFFRAMP
    )

    expect(hash).toBe(TXID)
    expect(tronWeb.trx!.getTransaction.mock.calls).toEqual([[TXID], [TXID], [TXID]])
  })

  test('refuses to sign at all when the provider cannot confirm a broadcast', async () => {
    const tronWeb = new DummyTronWeb()
    tronWeb.trx = undefined
    const account = new DummyTronAccount(tronWeb)

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      gatewayError(
        ERR.NOT_SUPPORTED,
        'this tron provider exposes no trx.getTransaction, so a broadcast could not be ' +
          'confirmed: pass a real tronweb instance as config.tronWeb, or a node URL as ' +
          'config.tronProvider'
      )
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  // `??` would let NaN/Infinity through, and both make a deadline that never passes.
  test.each([NaN, Infinity, -1])(
    'refuses a tronConfirmTimeoutMs of %s before broadcasting anything',
    async (tronConfirmTimeoutMs) => {
      const tronWeb = new DummyTronWeb()
      const account = new DummyTronAccount(tronWeb)

      await expect(
        gatewaySwidge(account, { tronConfirmTimeoutMs }).swidge(TRON_OFFRAMP)
      ).rejects.toMatchObject(
        gatewayError(
          ERR.VALIDATION,
          `config.tronConfirmTimeoutMs is ${tronConfirmTimeoutMs}, which is not a number of ` +
            'milliseconds we can wait for: pass a finite value of at least 0, or leave it unset ' +
            'for the 20000ms default'
        )
      )
      expect(account.sendTransaction).not.toHaveBeenCalled()
      expect(tronWeb.trx!.getTransaction).not.toHaveBeenCalled()
    }
  )

  // The account broadcasts through its own provider, so that is the node that can answer.
  test('reads the transaction back through the account provider, not the override', async () => {
    const own = new DummyTronWeb()
    const override = new DummyTronWeb()

    await gatewaySwidge(new DummyTronAccount(own), { tronWeb: override }).swidge(TRON_OFFRAMP)

    expect(own.trx!.getTransaction).toHaveBeenCalledWith(TXID)
    expect(override.trx!.getTransaction).not.toHaveBeenCalled()
  })

  test('falls back to the override when the account provider cannot confirm', async () => {
    const own = new DummyTronWeb()
    own.trx = undefined
    const override = new DummyTronWeb()

    await gatewaySwidge(new DummyTronAccount(own), { tronWeb: override }).swidge(TRON_OFFRAMP)

    expect(override.trx!.getTransaction).toHaveBeenCalledWith(TXID)
  })
})

// The account signs `txID` alone and only checks that the owner is itself, so a node that
// answers with a different call must be stopped before the signer sees it.
describe('swidge: a node response that is not the requested call', () => {
  const returned = (message: string) =>
    gatewayError(ERR.VALIDATION, `tron node returned ${message}`)

  afterEach(() => {
    vi.useRealTimers()
  })

  test.each([
    [
      'a substituted contract address',
      buildTronTx({ to: USDT }),
      `contract_address ${USDT_HEX} for the order call, expected ${REGISTRY_HEX}`,
    ],
    [
      'substituted calldata',
      buildTronTx({ data: 'deadbeef' }),
      `calldata deadbeef for the order call, expected ${ORDER_INPUT}`,
    ],
    [
      'an injected call_value that would drain TRX',
      buildTronTx({ callValue: 1_000_000_000 }),
      'call_value 1000000000 for the order call, expected 0',
    ],
    [
      'an inflated fee_limit',
      buildTronTx({ feeLimit: 5_000_000_000 }),
      'fee_limit 5000000000 for the order call, expected 50000000',
    ],
    [
      'a swapped owner',
      buildTronTx({ owner: USDT }),
      `owner_address ${USDT_HEX} for the order call, expected ${OWNER_HEX}`,
    ],
    [
      // The signer commits to txID, not to the readable raw_data.
      'a txID that is not the hash of the raw_data',
      { ...BUILT_TX, txID: 'a'.repeat(64) },
      'a transaction whose txID and raw_data_hex do not match its raw_data',
    ],
    [
      'a raw_data_hex that disagrees with raw_data',
      { ...BUILT_TX, raw_data_hex: '0a02beef' },
      'a transaction whose txID and raw_data_hex do not match its raw_data',
    ],
    // wdk-wallet-tron branches on `!tx.signature`: each of these makes it skip building, the
    // owner check and signing, then broadcast the object as-is. `[]` is empty but truthy.
    ...[['00'.repeat(65)], [], 'ff'].map((signature) => [
      `a signature of ${JSON.stringify(signature)}`,
      { ...BUILT_TX, signature },
      'a transaction carrying a signature, which the account would broadcast unsigned by us',
    ]),
    [
      // Passes txCheck — the fixture hashes the injected value in — so only the field check stops it.
      'an injected TRC-10 call_token_value',
      buildTronTx({ callTokenValue: 5_000, tokenId: 1_000_001 }),
      'call_token_value 5000 for the order call, expected 0',
    ],
    [
      'an injected TRC-10 token_id',
      buildTronTx({ tokenId: 1_000_001 }),
      'token_id 1000001 for the order call, expected 0',
    ],
    [
      'an injected memo, which the signer would commit to via txID',
      buildTronTx({ memo: '6465616462656566' }),
      'a transaction carrying a memo we did not ask for: 6465616462656566',
    ],
    [
      'a Permission_id routing the call through an unexamined multisig permission',
      buildTronTx({ permissionId: 2 }),
      'a Permission_id 2, expected the owner permission (0)',
    ],
    [
      'a contract type other than TriggerSmartContract',
      {
        ...BUILT_TX,
        raw_data: {
          ...BUILT_TX.raw_data,
          contract: [{ ...BUILT_TX.raw_data.contract[0], type: 'TransferContract' }],
        },
      },
      'a TransferContract, expected a TriggerSmartContract',
    ],
    [
      'more than one contract call bundled into the order',
      {
        ...BUILT_TX,
        raw_data: {
          ...BUILT_TX.raw_data,
          contract: [BUILT_TX.raw_data.contract[0], BUILT_TX.raw_data.contract[0]],
        },
      },
      '2 contract calls for the order, expected exactly 1',
    ],
  ] as [string, unknown, string][])('refuses %s', async (_label, tx, message) => {
    const account = new DummyTronAccount(hostile(tx))

    await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
      returned(message)
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  // Timing is the one part a node legitimately supplies, so it is bounded, not matched.
  describe('the validity window', () => {
    const NOW = 1_800_000_000_000

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })

    test.each([
      [
        'a stretched expiration that widens the replay window',
        { timestamp: NOW, expiration: NOW + 86_400_000 },
        'an expiration 86400000ms out, beyond the 600000ms we accept',
      ],
      [
        'a transaction whose window closed long ago',
        { timestamp: NOW - 2_400_000, expiration: NOW - 2_340_000 },
        'a transaction that expired 2340000ms ago',
      ],
      [
        'an expiration that precedes its own timestamp',
        { timestamp: NOW + 60_000, expiration: NOW + 59_000 },
        'a transaction that expires before it was created',
      ],
      [
        'a missing timestamp, which would leave the window unbounded',
        { timestamp: 0, expiration: NOW + 60_000 },
        'a transaction with no timestamp',
      ],
      [
        'a timestamp dated far into the future',
        { timestamp: NOW + 86_400_000 },
        'a timestamp 86400000ms ahead of local time',
      ],
    ])('refuses %s', async (_label, timing, message) => {
      const account = new DummyTronAccount(hostile(buildTronTx(timing)))

      await expect(gatewaySwidge(account).swidge(TRON_OFFRAMP)).rejects.toMatchObject(
        returned(message)
      )
      expect(account.sendTransaction).not.toHaveBeenCalled()
    })

    // The node dates the tx from chain time, so a host clock running ahead must not reject it.
    test('tolerates a just-expired transaction within the clock-skew allowance', async () => {
      const tx = buildTronTx({ timestamp: NOW - 120_000, expiration: NOW - 60_000 })
      const tronWeb = hostile(tx)
      const account = new DummyTronAccount(tronWeb)

      const { hash } = await gatewaySwidge(account).swidge(TRON_OFFRAMP)

      expect(account.sendTransaction).toHaveBeenCalledWith(tx)
      expect(hash).toBe(tx.txID)
    })
  })
})

describe('getRequiredApproval', () => {
  test('reads the allowance through the account provider and returns the approval', async () => {
    const tronWeb = new DummyTronWeb()

    const approval = await gatewaySwidge(new DummyTronAccount(tronWeb)).getRequiredApproval(
      TRON_OFFRAMP
    )

    expect(tronWeb.transactionBuilder.triggerConstantContract).toHaveBeenCalledWith(
      USDT,
      'allowance(address,address)',
      {},
      [
        { type: 'address', value: OWNER },
        { type: 'address', value: REGISTRY },
      ],
      OWNER
    )
    expect(approval).toEqual({ token: USDT, spender: REGISTRY, amount: MAX_UINT256 })
  })

  test('accepts the AllowanceHolder in its 0x hex form too', async () => {
    const spender = '0x07a39ae4c49dee86e892450b20881f32cd5d500d'
    createOrder.mockResolvedValue(tronOfframpOrder({ to: spender }))

    const approval = await gatewaySwidge(
      new DummyTronAccount(new DummyTronWeb())
    ).getRequiredApproval(TRON_OFFRAMP)

    expect(approval).toEqual({ token: USDT, spender, amount: MAX_UINT256 })
  })

  test('refuses an unbounded approval to a spender that is not the Tron AllowanceHolder', async () => {
    createOrder.mockResolvedValue(tronOfframpOrder({ to: SPENDER }))

    await expect(
      gatewaySwidge(new DummyTronAccount(new DummyTronWeb())).getRequiredApproval(TRON_OFFRAMP)
    ).rejects.toMatchObject(
      gatewayError(
        ERR.VALIDATION,
        `refusing to sign the order: order tx targets ${SPENDER}, expected the AllowanceHolder ` +
          'at 0x07a39ae4c49dee86e892450b20881f32cd5d500d'
      )
    )
  })

  test('returns null when the allowance already covers the amount', async () => {
    const tronWeb = new DummyTronWeb()
    tronWeb.transactionBuilder.triggerConstantContract.mockResolvedValue({
      constant_result: [word(50_000_000n)],
    })

    const approval = await gatewaySwidge(new DummyTronAccount(tronWeb)).getRequiredApproval(
      TRON_OFFRAMP
    )

    expect(approval).toBe(null)
  })

  test.each([
    '0x0000000000000000000000000000000000000000',
    '410000000000000000000000000000000000000000',
    'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  ])('returns null for native TRX spelled %s, without an allowance read', async (native) => {
    const quote = tronOfframpQuote()
    quote.offramp.inputAmount.address = native
    quote.offramp.tokenAddress = native
    getQuote.mockResolvedValue(quote)
    // A native source is exec'd as the zero-address token, its amount paid as call value.
    createOrder.mockResolvedValue(
      tronOfframpOrder({ data: execData({ token: ZERO, amount: 50_000_000n }), value: '50000000' })
    )
    const tronWeb = new DummyTronWeb()

    const approval = await gatewaySwidge(new DummyTronAccount(tronWeb)).getRequiredApproval({
      ...TRON_OFFRAMP,
      fromToken: native,
    })

    expect(approval).toBe(null)
    expect(tronWeb.transactionBuilder.triggerConstantContract).not.toHaveBeenCalled()
  })

  // Revert data parses as a valid, enormous integer — it must not read as "already approved".
  test.each([
    [
      'nothing',
      { constant_result: [] },
      ERR.HTTP,
      `allowance() returned 0 results for ${USDT}, expected 1`,
    ],
    [
      'revert data under result: false',
      {
        result: { result: false },
        constant_result: [
          '08c379a0' +
            '0000000000000000000000000000000000000000000000000000000000000020' +
            '0000000000000000000000000000000000000000000000000000000000000004' +
            '6f6f70730000000000000000000000000000000000000000000000000000000000',
        ],
      },
      ERR.HTTP,
      `tron node rejected the allowance() read on ${USDT}`,
    ],
    [
      'a result that is not one 32-byte word, with the node claiming success',
      { constant_result: ['deadbeef'] },
      ERR.HTTP,
      `allowance() returned a 8-char result for ${USDT}, expected one 32-byte uint256 word`,
    ],
    [
      'two words',
      { constant_result: [word(1000n), word(1n)] },
      ERR.HTTP,
      `allowance() returned 2 results for ${USDT}, expected 1`,
    ],
  ])('throws when allowance() answers with %s', async (_label, response, code, message) => {
    const tronWeb = new DummyTronWeb()
    tronWeb.transactionBuilder.triggerConstantContract.mockResolvedValue(response)

    await expect(
      gatewaySwidge(new DummyTronAccount(tronWeb)).getRequiredApproval(TRON_OFFRAMP)
    ).rejects.toMatchObject(gatewayError(code, message))
  })
})

describe('simulateSwidge', () => {
  const PAYLOAD_TX = { to: REGISTRY, data: TRON_OFFRAMP_EXEC, value: '0', feeLimit: '50000000' }

  test('quotes the fee from the built call and reports the approval, without broadcasting', async () => {
    const tronWeb = new DummyTronWeb()
    const account = new DummyTronAccount(tronWeb)
    account.quoteSendTransaction = vi.fn(async () => ({ fee: 27_000_000n, activationFee: 0n }))

    const result = await gatewaySwidge(account).simulateSwidge(TRON_OFFRAMP)

    expect(account.quoteSendTransaction).toHaveBeenCalledWith(BUILT_TX)
    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(registerTx).not.toHaveBeenCalled()
    expect(result).toEqual({
      variant: 'offramp',
      orderId: 'order-tron',
      quote: SWIDGE_QUOTE,
      broadcast: false,
      tron: {
        tx: PAYLOAD_TX,
        feeEstimate: 27_000_000n,
        requiredApproval: { token: USDT, spender: REGISTRY, amount: MAX_UINT256 },
        valid: true,
      },
    })
  })

  test('reports no approval once the allowance covers the amount', async () => {
    const tronWeb = new DummyTronWeb()
    tronWeb.transactionBuilder.triggerConstantContract.mockResolvedValue({
      constant_result: [word(50_000_000n)],
    })
    const account = new DummyTronAccount(tronWeb)
    account.quoteSendTransaction = vi.fn(async () => ({ fee: 27_000_000n }))

    const { tron } = (await gatewaySwidge(account).simulateSwidge(TRON_OFFRAMP)) as {
      tron: unknown
    }

    expect(tron).toEqual({
      tx: PAYLOAD_TX,
      feeEstimate: 27_000_000n,
      requiredApproval: null,
      valid: true,
    })
  })

  // Deliberate divergence from EVM (which throws NOT_SUPPORTED): on Tron the build itself is the
  // execution check, so `valid` is earned without a quote method.
  test('an account without quoteSendTransaction still gets a validity verdict', async () => {
    const { tron } = (await gatewaySwidge(new DummyTronAccount(new DummyTronWeb())).simulateSwidge(
      TRON_OFFRAMP
    )) as { tron: unknown }

    expect(tron).toEqual({
      tx: PAYLOAD_TX,
      feeEstimate: null,
      requiredApproval: { token: USDT, spender: REGISTRY, amount: MAX_UINT256 },
      valid: true,
    })
  })

  test.each([
    [
      'a reverting build',
      (tronWeb: DummyTronWeb) =>
        tronWeb.transactionBuilder.triggerSmartContract.mockRejectedValue(
          new Error('REVERT opcode executed')
        ),
      { token: USDT, spender: REGISTRY, amount: MAX_UINT256 },
      'REVERT opcode executed',
    ],
    [
      'a failing allowance read',
      (tronWeb: DummyTronWeb) =>
        tronWeb.transactionBuilder.triggerConstantContract.mockRejectedValue(
          new Error('node unreachable')
        ),
      null,
      'node unreachable',
    ],
    [
      'a mismatched build',
      (tronWeb: DummyTronWeb) =>
        tronWeb.transactionBuilder.triggerSmartContract.mockResolvedValue({
          transaction: buildTronTx({ data: 'deadbeef' }),
        }),
      { token: USDT, spender: REGISTRY, amount: MAX_UINT256 },
      `tron node returned calldata deadbeef for the order call, expected ${ORDER_INPUT}`,
    ],
  ])(
    '%s reports valid: false with the reason rather than throwing',
    async (_l, bend, approval, reason) => {
      const tronWeb = new DummyTronWeb()
      bend(tronWeb)

      const { tron } = (await gatewaySwidge(new DummyTronAccount(tronWeb)).simulateSwidge(
        TRON_OFFRAMP
      )) as { tron: unknown }

      expect(tron).toEqual({
        tx: PAYLOAD_TX,
        feeEstimate: null,
        requiredApproval: approval,
        valid: false,
        reason,
      })
    }
  )

  test('config.tronProvider reuses one client per node URL, evicting the least recently used', async () => {
    const urls = [0, 0, 1, 2, 3, 4, 5, 6, 7, 0, 8, 0, 1].map((i) => `https://node-${i}`)

    for (const tronProvider of urls) {
      await gatewaySwidge(new DummyTronAccount(), { tronProvider }).simulateSwidge(TRON_OFFRAMP)
    }

    // Eight fit; node-8 evicts node-1 (node-0 was used since), so node-1 is built again.
    expect(tronWebCtor.mock.calls).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 1].map((i) => [`https://node-${i}`])
    )
  })
})

describe('buildTronApproval', () => {
  test('produces a TronSmartContractCall the WDK account accepts directly', () => {
    const call = buildTronApproval({ token: USDT, spender: REGISTRY, amount: MAX_UINT256 })

    expect(call).toEqual({
      contractAddress: USDT,
      functionSelector: 'approve(address,uint256)',
      parameters: [
        { type: 'address', value: REGISTRY },
        { type: 'uint256', value: MAX_UINT256.toString() },
      ],
      options: { feeLimit: 100_000_000 },
    })
  })

  test('takes a fee limit override', () => {
    const call = buildTronApproval({ token: USDT, spender: REGISTRY, amount: 1 }, { feeLimit: 10 })

    expect(call).toEqual({
      contractAddress: USDT,
      functionSelector: 'approve(address,uint256)',
      parameters: [
        { type: 'address', value: REGISTRY },
        { type: 'uint256', value: '1' },
      ],
      options: { feeLimit: 10 },
    })
  })
})

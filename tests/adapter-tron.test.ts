import { describe, test, expect, vi } from 'vitest'
import { tronAdapter, buildTronApproval } from '../src/chain-adapters/tron.js'
import type { TronWebLike } from '../src/chain-adapters/tron.js'
import { buildTronTx, OWNER, REGISTRY, USDT, SPENDER } from './fixtures/tron.js'

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

function word(n: bigint): string {
  return n.toString(16).padStart(64, '0')
}

type FakeTronWeb = TronWebLike & {
  transactionBuilder: Record<string, ReturnType<typeof vi.fn>>
  trx: { getTransaction: ReturnType<typeof vi.fn> }
}

/**
 * A node that honours the call it was asked to build. Responses are derived from the
 * arguments, so the adapter's pre-signing checks pass unless a test bends them.
 * `trx.getTransaction` answers, i.e. the node accepted what was broadcast.
 */
function fakeTronWeb(overrides: Partial<TronWebLike['transactionBuilder']> = {}): FakeTronWeb {
  return {
    trx: { getTransaction: vi.fn(async (txid: string) => ({ txID: txid })) },
    transactionBuilder: {
      triggerSmartContract: vi.fn(
        async (
          to: string,
          _selector: string,
          options: { input: string; callValue: number; feeLimit: number },
          _parameters: unknown[],
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
      ...overrides,
    },
  } as unknown as FakeTronWeb
}

/** A node that ignores the request and answers with `tx` instead. */
function hostileTronWeb(tx: unknown): FakeTronWeb {
  return fakeTronWeb({
    triggerSmartContract: vi.fn(async () => ({ transaction: tx })),
  } as unknown as Partial<TronWebLike['transactionBuilder']>)
}

// The gateway's TronTxData: base58 `to`, 0x-prefixed calldata, sun `value`/`feeLimit`.
const TX = { to: REGISTRY, data: '0xabcdef', value: '0', feeLimit: '50000000' }

/** txID of the transaction `fakeTronWeb` builds for `TX`. */
const TXID = buildTronTx().txID

function sender(overrides: Record<string, unknown> = {}) {
  return {
    getAddress: async () => OWNER,
    sendTransaction: vi.fn(async (tx: { txID: string }) => ({ hash: tx.txID })),
    ...overrides,
  }
}

describe('tronAdapter.send', () => {
  test('builds the call from raw calldata and broadcasts the pre-built tx', async () => {
    const tronWeb = fakeTronWeb()
    const account = sender()
    const out = await tronAdapter.send(account, { tx: TX }, { tronWeb })

    // Empty selector + options.input is the only tronweb path that accepts pre-encoded
    // calldata; the 0x prefix must be stripped and the amounts passed as integers.
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      REGISTRY,
      '',
      { input: 'abcdef', callValue: 0, feeLimit: 50000000 },
      [],
      OWNER
    )
    expect(account.sendTransaction).toHaveBeenCalledWith(buildTronTx())
    expect(out).toEqual({ txid: TXID })
  })

  test('falls back to the 100 TRX default when the order omits feeLimit', async () => {
    const tronWeb = fakeTronWeb()
    await tronAdapter.send(
      sender(),
      { tx: { to: REGISTRY, data: '0xaa', value: '0' } },
      { tronWeb }
    )
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      REGISTRY,
      '',
      { input: 'aa', callValue: 0, feeLimit: 100_000_000 },
      [],
      OWNER
    )
  })

  test('uses the account provider when no override is configured', async () => {
    const tronWeb = fakeTronWeb()
    await tronAdapter.send(sender({ _tronWeb: tronWeb }), { tx: TX })
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalled()
  })

  test('an explicit tronWeb wins over the account provider', async () => {
    const own = fakeTronWeb()
    const override = fakeTronWeb()
    await tronAdapter.send(sender({ _tronWeb: own }), { tx: TX }, { tronWeb: override })
    expect(override.transactionBuilder.triggerSmartContract).toHaveBeenCalled()
    expect(own.transactionBuilder.triggerSmartContract).not.toHaveBeenCalled()
  })

  test('throws when no provider can be resolved', async () => {
    await expect(tronAdapter.send(sender(), { tx: TX })).rejects.toThrow(/no tron provider/i)
  })

  test('throws when the account cannot send', async () => {
    await expect(
      tronAdapter.send({ getAddress: async () => OWNER }, { tx: TX }, { tronWeb: fakeTronWeb() })
    ).rejects.toThrow(/cannot send transactions/i)
  })

  test('rejects empty calldata', async () => {
    await expect(
      tronAdapter.send(
        sender(),
        { tx: { to: REGISTRY, data: '0x', value: '0' } },
        { tronWeb: fakeTronWeb() }
      )
    ).rejects.toThrow(/tx.data is empty/)
  })

  test('rejects a value beyond the safe integer range rather than silently truncating', async () => {
    await expect(
      tronAdapter.send(
        sender(),
        { tx: { to: REGISTRY, data: '0xaa', value: '9007199254740993' } },
        { tronWeb: fakeTronWeb() }
      )
    ).rejects.toThrow(/safe integer range/)
  })

  test('a provider override does not make a disconnected account able to broadcast', async () => {
    // config.tronWeb / config.tronProvider only pick the node that BUILDS the call.
    // WalletAccountTron.sendTransaction still needs its own provider, and says so.
    const account = sender({
      sendTransaction: async () => {
        throw new Error('The wallet must be connected to tron web to send transactions.')
      },
    })
    await expect(tronAdapter.send(account, { tx: TX }, { tronWeb: fakeTronWeb() })).rejects.toThrow(
      /must be connected to tron web/
    )
  })

  test('surfaces a node that returns no transaction', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => ({})),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /no transaction for the order call/
    )
  })

  test('surfaces a node that reports failure alongside a transaction', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => ({
        result: { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: 'no such contract' },
        transaction: buildTronTx(),
      })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /rejected the order call: CONTRACT_VALIDATE_ERROR: no such contract/
    )
  })

  test('surfaces a node that answers with a bare result: false', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => ({ result: false, transaction: buildTronTx() })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /rejected the order call/
    )
  })

  test('reports a rejection whose code and message are not strings', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => ({
        result: { result: false, code: Symbol('code'), message: Symbol('message') },
      })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /rejected the order call$/
    )
  })

  test('surfaces a node that reports a top-level Error', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => ({
        Error: 'class org.tron.core.exception.ContractValidateException',
        transaction: buildTronTx(),
      })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /rejected the order call: class org.tron.core.exception/
    )
  })

  test('a node that omits the status field is still accepted', async () => {
    const tronWeb = fakeTronWeb()
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).resolves.toEqual({
      txid: TXID,
    })
  })
})

describe('tronAdapter.send confirms the broadcast', () => {
  test('reads the returned hash back from the node', async () => {
    const tronWeb = fakeTronWeb()
    await tronAdapter.send(sender(), { tx: TX }, { tronWeb })
    expect(tronWeb.trx.getTransaction).toHaveBeenCalledWith(TXID)
  })

  test('rejects a hash that is not the txID we signed, before looking it up', async () => {
    const tronWeb = fakeTronWeb()
    const foreign = buildTronTx({ data: 'deadbeef' }).txID
    const account = sender({ sendTransaction: vi.fn(async () => ({ hash: foreign })) })
    await expect(tronAdapter.send(account, { tx: TX }, { tronWeb })).rejects.toThrow(
      new RegExp(`returned hash ${foreign}, but the transaction we built and signed is ${TXID}`)
    )
    expect(tronWeb.trx.getTransaction).not.toHaveBeenCalled()
  })

  test('accepts the same txID in upper case and with an 0x prefix', async () => {
    const tronWeb = fakeTronWeb()
    const account = sender({
      sendTransaction: vi.fn(async () => ({ hash: `0x${TXID.toUpperCase()}` })),
    })
    await expect(tronAdapter.send(account, { tx: TX }, { tronWeb })).resolves.toEqual({
      txid: TXID,
    })
    expect(tronWeb.trx.getTransaction).toHaveBeenCalledWith(TXID)
  })

  test('throws when the node never learns the transaction', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.getTransaction = vi.fn(async () => {
      throw new Error('Transaction not found')
    })
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb, confirmTimeoutMs: 0 })
    ).rejects.toThrow(
      new RegExp(`still does not know transaction ${TXID} 0ms after broadcasting it`)
    )
  })

  test('keeps polling until the node answers', async () => {
    const tronWeb = fakeTronWeb()
    let calls = 0
    tronWeb.trx.getTransaction = vi.fn(async (txid: string) => {
      if (++calls < 3) throw new Error('Transaction not found')
      return { txID: txid }
    })
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb, confirmTimeoutMs: 5_000 })
    ).resolves.toEqual({ txid: TXID })
    expect(calls).toBe(3)
  })

  test('fails immediately when the account comes back without a hash', async () => {
    const tronWeb = fakeTronWeb()
    const account = sender({
      sendTransaction: vi.fn(async () => ({}) as unknown as { hash: string }),
    })
    await expect(tronAdapter.send(account, { tx: TX }, { tronWeb })).rejects.toThrow(
      /returned no transaction hash for the order call/
    )
    expect(tronWeb.trx.getTransaction).not.toHaveBeenCalled()
  })

  test('refuses to sign at all when the provider cannot confirm a broadcast', async () => {
    const tronWeb = fakeTronWeb()
    delete (tronWeb as { trx?: unknown }).trx
    const account = sender()
    await expect(tronAdapter.send(account, { tx: TX }, { tronWeb })).rejects.toThrow(
      /exposes no trx.getTransaction/
    )
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  // tronweb raises on an empty `wallet/gettransactionbyid` body, but `trx.getTransaction` is
  // structurally typed: a provider passed as config.tronWeb need not raise on anything.
  test('a provider that resolves instead of raising on not-found does not confirm', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.getTransaction = vi.fn(async () => ({}))
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb, confirmTimeoutMs: 0 })
    ).rejects.toThrow(new RegExp(`still does not know transaction ${TXID}`))
  })

  test('a body for some other transaction does not confirm ours', async () => {
    const tronWeb = fakeTronWeb()
    const foreign = buildTronTx({ data: 'deadbeef' }).txID
    tronWeb.trx.getTransaction = vi.fn(async () => ({ txID: foreign }))
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb, confirmTimeoutMs: 0 })
    ).rejects.toThrow(new RegExp(`still does not know transaction ${TXID}`))
  })

  test('keeps polling past an empty body until the node answers with our transaction', async () => {
    const tronWeb = fakeTronWeb()
    let calls = 0
    tronWeb.trx.getTransaction = vi.fn(async (txid: string) =>
      ++calls < 3 ? {} : { txID: txid.toUpperCase() }
    )
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb, confirmTimeoutMs: 5_000 })
    ).resolves.toEqual({ txid: TXID })
    expect(calls).toBe(3)
  })

  // `??` would let either through, and both make the deadline one that never passes.
  test.each([NaN, Infinity, -1])(
    'refuses a confirmTimeoutMs of %s before broadcasting anything',
    async (confirmTimeoutMs) => {
      const tronWeb = fakeTronWeb()
      const account = sender()
      await expect(
        tronAdapter.send(account, { tx: TX }, { tronWeb, confirmTimeoutMs })
      ).rejects.toThrow(/tronConfirmTimeoutMs is .* not a number of milliseconds/)
      expect(account.sendTransaction).not.toHaveBeenCalled()
      expect(tronWeb.trx.getTransaction).not.toHaveBeenCalled()
    }
  )

  // The account broadcasts through its own provider, so that is the node that can answer.
  test('reads the transaction back through the account provider, not the override', async () => {
    const own = fakeTronWeb()
    const override = fakeTronWeb()
    await tronAdapter.send(sender({ _tronWeb: own }), { tx: TX }, { tronWeb: override })
    expect(own.trx.getTransaction).toHaveBeenCalledWith(TXID)
    expect(override.trx.getTransaction).not.toHaveBeenCalled()
  })

  test('falls back to the override when the account provider cannot confirm', async () => {
    const own = fakeTronWeb()
    delete (own as { trx?: unknown }).trx
    const override = fakeTronWeb()
    await tronAdapter.send(sender({ _tronWeb: own }), { tx: TX }, { tronWeb: override })
    expect(override.trx.getTransaction).toHaveBeenCalledWith(TXID)
  })
})

// The account signs `txID` alone and only checks that the owner is itself, so a node
// that answers with a different call must be stopped here, before the signer sees it.
describe('tronAdapter.send rejects a node response that is not the requested call', () => {
  test('a substituted contract address', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ to: USDT }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /contract_address .* expected/
    )
  })

  test('substituted calldata', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ data: 'deadbeef' }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /calldata deadbeef .* expected abcdef/
    )
  })

  test('an injected call_value that would drain TRX', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ callValue: 1_000_000_000 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /call_value 1000000000 .* expected 0/
    )
  })

  test('an inflated fee_limit', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ feeLimit: 5_000_000_000 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /fee_limit 5000000000 .* expected 50000000/
    )
  })

  test('a swapped owner', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ owner: USDT }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /owner_address .* expected/
    )
  })

  test('a txID that is not the hash of the raw_data we can read', async () => {
    // The signer commits to txID, not to the readable raw_data.
    const tampered = { ...buildTronTx(), txID: 'a'.repeat(64) }
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb: hostileTronWeb(tampered) })
    ).rejects.toThrow(/txID and raw_data_hex do not match/)
  })

  test('a raw_data_hex that disagrees with raw_data', async () => {
    const tampered = { ...buildTronTx(), raw_data_hex: '0a02beef' }
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb: hostileTronWeb(tampered) })
    ).rejects.toThrow(/txID and raw_data_hex do not match/)
  })

  // wdk-wallet-tron branches on `!tx.signature`, so every one of these makes it skip
  // building, the owner check and signing, then broadcast the object as-is. `[]` is the
  // sharp edge: empty, but truthy in JS.
  test.each([
    ['a populated signature', ['00'.repeat(65)]],
    ['an empty signature array', []],
    ['a non-array truthy signature', 'ff'],
  ])('%s the account would broadcast unsigned by us', async (_label, signature) => {
    const presigned = { ...buildTronTx(), signature }
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb: hostileTronWeb(presigned) })
    ).rejects.toThrow(/carrying a signature/)
  })

  test('injected TRC-10 call_token_value, serialized into the signed payload', async () => {
    // Passes txCheck — the fixture hashes the injected value in — so only the explicit
    // field check stops it.
    const tronWeb = hostileTronWeb(buildTronTx({ callTokenValue: 5_000, tokenId: 1_000_001 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /call_token_value 5000 .* expected 0/
    )
  })

  test('an injected TRC-10 token_id', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ tokenId: 1_000_001 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /token_id 1000001 .* expected 0/
    )
  })

  test('a stretched expiration that widens the replay window', async () => {
    const timestamp = Date.now()
    const tronWeb = hostileTronWeb(buildTronTx({ timestamp, expiration: timestamp + 86_400_000 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /expiration .* beyond the 600000ms we accept/
    )
  })

  test('a transaction whose window closed long ago', async () => {
    const timestamp = Date.now() - 40 * 60 * 1000
    const tronWeb = hostileTronWeb(buildTronTx({ timestamp, expiration: timestamp + 60_000 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /expired \d+ms ago/
    )
  })

  test('a just-expired transaction is tolerated within the clock-skew allowance', async () => {
    const timestamp = Date.now() - 120_000
    const tx = buildTronTx({ timestamp, expiration: timestamp + 60_000 })
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb: hostileTronWeb(tx) })
    ).resolves.toEqual({ txid: tx.txID })
  })

  test('an expiration that precedes its own timestamp', async () => {
    const timestamp = Date.now() + 60_000
    const tronWeb = hostileTronWeb(buildTronTx({ timestamp, expiration: timestamp - 1_000 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /expires before it was created/
    )
  })

  test('a missing timestamp, which would leave the window unbounded', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ timestamp: 0, expiration: Date.now() + 60_000 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /no timestamp/
    )
  })

  test('an injected memo, which the signer would commit to via txID', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ memo: '6465616462656566' }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /memo we did not ask for/
    )
  })

  test('a Permission_id routing the call through an unexamined multisig permission', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ permissionId: 2 }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /Permission_id 2, expected the owner permission/
    )
  })

  test('a timestamp dated far into the future', async () => {
    const timestamp = Date.now() + 86_400_000
    const tronWeb = hostileTronWeb(buildTronTx({ timestamp }))
    await expect(tronAdapter.send(sender(), { tx: TX }, { tronWeb })).rejects.toThrow(
      /timestamp .* ahead of local time/
    )
  })

  test('a contract type other than TriggerSmartContract', async () => {
    const tx = buildTronTx()
    const swapped = {
      ...tx,
      raw_data: {
        ...tx.raw_data,
        contract: [{ ...tx.raw_data.contract[0], type: 'TransferContract' }],
      },
    }
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb: hostileTronWeb(swapped) })
    ).rejects.toThrow(/TransferContract, expected a TriggerSmartContract/)
  })

  test('more than one contract call bundled into the order', async () => {
    const tx = buildTronTx()
    const bundled = {
      ...tx,
      raw_data: { ...tx.raw_data, contract: [tx.raw_data.contract[0], tx.raw_data.contract[0]] },
    }
    await expect(
      tronAdapter.send(sender(), { tx: TX }, { tronWeb: hostileTronWeb(bundled) })
    ).rejects.toThrow(/2 contract calls for the order/)
  })
})

describe('tronAdapter.getRequiredApproval', () => {
  const account = { getAddress: async () => OWNER }

  test('returns the approval when the allowance is short', async () => {
    const tronWeb = fakeTronWeb()
    const out = await tronAdapter.getRequiredApproval(account, USDT, SPENDER, 500n, {
      tronWeb,
    })
    expect(tronWeb.transactionBuilder.triggerConstantContract).toHaveBeenCalledWith(
      USDT,
      'allowance(address,address)',
      {},
      [
        { type: 'address', value: OWNER },
        { type: 'address', value: SPENDER },
      ],
      OWNER
    )
    expect(out).toEqual({ token: USDT, spender: SPENDER, amount: 500n })
  })

  test('returns null when the allowance already covers the amount', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [word(1000n)] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    expect(
      await tronAdapter.getRequiredApproval(account, USDT, SPENDER, 500n, { tronWeb })
    ).toBeNull()
  })

  test('returns null for native TRX in every spelling, without an allowance call', async () => {
    const tronWeb = fakeTronWeb()
    for (const native of [
      '',
      '0x0000000000000000000000000000000000000000',
      '410000000000000000000000000000000000000000',
      'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    ]) {
      expect(
        await tronAdapter.getRequiredApproval(account, native, SPENDER, 500n, { tronWeb })
      ).toBeNull()
    }
    expect(tronWeb.transactionBuilder.triggerConstantContract).not.toHaveBeenCalled()
  })

  test('throws when allowance() returns nothing', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(
      tronAdapter.getRequiredApproval(account, USDT, SPENDER, 500n, { tronWeb })
    ).rejects.toThrow(/returned 0 results .* expected 1/)
  })

  test('throws on revert data rather than reading it as a huge allowance', async () => {
    const revert =
      '08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      '6f6f70730000000000000000000000000000000000000000000000000000000000'
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({
        result: { result: false },
        constant_result: [revert],
      })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(
      tronAdapter.getRequiredApproval(account, USDT, SPENDER, 500n, { tronWeb })
    ).rejects.toThrow(/rejected the allowance\(\) read/)
  })

  test('throws on a result that is not one 32-byte word, even when the node claims success', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: ['deadbeef'] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(
      tronAdapter.getRequiredApproval(account, USDT, SPENDER, 500n, { tronWeb })
    ).rejects.toThrow(/expected one 32-byte uint256 word/)
  })

  test('throws when allowance() answers with more than one word', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [word(1000n), word(1n)] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(
      tronAdapter.getRequiredApproval(account, USDT, SPENDER, 500n, { tronWeb })
    ).rejects.toThrow(/returned 2 results .* expected 1/)
  })
})

describe('tronAdapter.simulate', () => {
  test('quotes the fee and reports no approval needed', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [word(1000n)] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    const account = {
      getAddress: async () => OWNER,
      quoteSendTransaction: vi.fn(async () => ({ fee: 27_000_000n, activationFee: 0n })),
    }
    const out = await tronAdapter.simulate(
      account,
      { tx: TX },
      {
        tronWeb,
        token: USDT,
        amount: 500n,
      }
    )
    expect(account.quoteSendTransaction).toHaveBeenCalledWith(buildTronTx())
    expect(out).toEqual({
      tx: TX,
      feeEstimate: 27_000_000n,
      requiredApproval: null,
      valid: true,
    })
  })

  test('spender defaults to the order tx target', async () => {
    const tronWeb = fakeTronWeb()
    const account = { getAddress: async () => OWNER }
    const out = await tronAdapter.simulate(
      account,
      { tx: TX },
      { tronWeb, token: USDT, amount: 500n }
    )
    expect(out.requiredApproval).toEqual({
      token: USDT,
      spender: REGISTRY,
      amount: 500n,
    })
    expect(out.feeEstimate).toBeNull()
  })

  test('an account without quoteSendTransaction still gets a validity verdict', async () => {
    // Deliberate divergence from the EVM adapter (which throws NOT_SUPPORTED): on Tron the
    // build itself is the execution check, so `valid` is earned without a quote method.
    const tronWeb = fakeTronWeb()
    const account = { getAddress: async () => OWNER }
    const out = await tronAdapter.simulate(account, { tx: TX }, { tronWeb })
    expect(out.valid).toBe(true)
    expect(out.feeEstimate).toBeNull()
    expect(out.reason).toBeUndefined()
  })

  test('a reverting build reports valid:false with the reason, not a throw', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => {
        throw new Error('REVERT opcode executed')
      }),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    const account = { getAddress: async () => OWNER }
    const out = await tronAdapter.simulate(account, { tx: TX }, { tronWeb })
    expect(out.valid).toBe(false)
    expect(out.reason).toMatch(/REVERT/)
    expect(out.feeEstimate).toBeNull()
  })

  test('a failing allowance read reports valid:false rather than throwing', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => {
        throw new Error('node unreachable')
      }),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    const account = { getAddress: async () => OWNER }
    const out = await tronAdapter.simulate(
      account,
      { tx: TX },
      { tronWeb, token: USDT, amount: 500n }
    )
    expect(out.valid).toBe(false)
    expect(out.reason).toMatch(/node unreachable/)
    expect(out.requiredApproval).toBeNull()
  })

  test('a mismatched build reports valid:false rather than throwing', async () => {
    const tronWeb = hostileTronWeb(buildTronTx({ data: 'deadbeef' }))
    const account = { getAddress: async () => OWNER }
    const out = await tronAdapter.simulate(account, { tx: TX }, { tronWeb })
    expect(out.valid).toBe(false)
    expect(out.reason).toMatch(/calldata deadbeef/)
  })
})

describe('buildTronApproval', () => {
  test('produces a TronSmartContractCall the WDK account accepts directly', () => {
    expect(buildTronApproval({ token: USDT, spender: SPENDER, amount: 500n })).toEqual({
      contractAddress: USDT,
      functionSelector: 'approve(address,uint256)',
      parameters: [
        { type: 'address', value: SPENDER },
        { type: 'uint256', value: '500' },
      ],
      options: { feeLimit: 100_000_000 },
    })
  })

  test('feeLimit is overridable', () => {
    expect(
      buildTronApproval({ token: USDT, spender: SPENDER, amount: 1 }, { feeLimit: 10 }).options
    ).toEqual({ feeLimit: 10 })
  })
})

describe('tron provider cache', () => {
  test('reuses one client per node URL and evicts the least recently used', async () => {
    const at = (url: string) => tronAdapter.simulate(sender(), { tx: TX }, { tronProvider: url })

    await at('https://node-0')
    await at('https://node-0')
    expect(tronWebCtor).toHaveBeenCalledTimes(1)

    for (let i = 1; i < 8; i++) await at(`https://node-${i}`)
    await at('https://node-0')
    expect(tronWebCtor).toHaveBeenCalledTimes(8)

    await at('https://node-8')
    await at('https://node-0')
    expect(tronWebCtor).toHaveBeenCalledTimes(9)
    await at('https://node-1')
    expect(tronWebCtor).toHaveBeenCalledTimes(10)
  })
})

import { describe, test, expect, vi } from 'vitest'
import { tronAdapter, buildTronApproval } from '../src/chain-adapters/tron.js'
import type { TronWebLike } from '../src/chain-adapters/tron.js'

const UNSIGNED = { txID: 'deadbeef', raw_data: {}, raw_data_hex: '0a02' }

function word(n: bigint): string {
  return n.toString(16).padStart(64, '0')
}

function fakeTronWeb(
  overrides: Partial<TronWebLike['transactionBuilder']> = {}
): TronWebLike & { transactionBuilder: Record<string, ReturnType<typeof vi.fn>> } {
  return {
    transactionBuilder: {
      triggerSmartContract: vi.fn(async () => ({ transaction: UNSIGNED })),
      triggerConstantContract: vi.fn(async () => ({ constant_result: [word(0n)] })),
      ...overrides,
    },
  } as unknown as TronWebLike & { transactionBuilder: Record<string, ReturnType<typeof vi.fn>> }
}

// The gateway's TronTxData: base58 `to`, 0x-prefixed calldata, sun `value`/`feeLimit`.
const TX = { to: 'TRegistryAddress', data: '0xabcdef', value: '0', feeLimit: '50000000' }

describe('tronAdapter.send', () => {
  test('builds the call from raw calldata and broadcasts the pre-built tx', async () => {
    const tronWeb = fakeTronWeb()
    const account = {
      getAddress: async () => 'TSender',
      sendTransaction: vi.fn(async () => ({ hash: 'txid1' })),
    }
    const out = await tronAdapter.send(account, { tx: TX }, { tronWeb })

    // Empty selector + options.input is the only tronweb path that accepts pre-encoded
    // calldata; the 0x prefix must be stripped and the amounts passed as integers.
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      'TRegistryAddress',
      '',
      { input: 'abcdef', callValue: 0, feeLimit: 50000000 },
      [],
      'TSender'
    )
    expect(account.sendTransaction).toHaveBeenCalledWith(UNSIGNED)
    expect(out).toEqual({ txid: 'txid1' })
  })

  test('falls back to the 100 TRX default when the order omits feeLimit', async () => {
    const tronWeb = fakeTronWeb()
    const account = {
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await tronAdapter.send(account, { tx: { to: 'TReg', data: '0xaa', value: '0' } }, { tronWeb })
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      'TReg',
      '',
      { input: 'aa', callValue: 0, feeLimit: 100_000_000 },
      [],
      'TSender'
    )
  })

  test('uses the account provider when no override is configured', async () => {
    const tronWeb = fakeTronWeb()
    const account = {
      _tronWeb: tronWeb,
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await tronAdapter.send(account, { tx: TX })
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalled()
  })

  test('an explicit tronWeb wins over the account provider', async () => {
    const own = fakeTronWeb()
    const override = fakeTronWeb()
    const account = {
      _tronWeb: own,
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await tronAdapter.send(account, { tx: TX }, { tronWeb: override })
    expect(override.transactionBuilder.triggerSmartContract).toHaveBeenCalled()
    expect(own.transactionBuilder.triggerSmartContract).not.toHaveBeenCalled()
  })

  test('throws when no provider can be resolved', async () => {
    const account = {
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await expect(tronAdapter.send(account, { tx: TX })).rejects.toThrow(/no tron provider/i)
  })

  test('throws when the account cannot send', async () => {
    await expect(
      tronAdapter.send(
        { getAddress: async () => 'TSender' },
        { tx: TX },
        { tronWeb: fakeTronWeb() }
      )
    ).rejects.toThrow(/cannot send transactions/i)
  })

  test('rejects empty calldata', async () => {
    const account = {
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await expect(
      tronAdapter.send(
        account,
        { tx: { to: 'TReg', data: '0x', value: '0' } },
        { tronWeb: fakeTronWeb() }
      )
    ).rejects.toThrow(/tx.data is empty/)
  })

  test('rejects a value beyond the safe integer range rather than silently truncating', async () => {
    const account = {
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await expect(
      tronAdapter.send(
        account,
        { tx: { to: 'TReg', data: '0xaa', value: '9007199254740993' } },
        { tronWeb: fakeTronWeb() }
      )
    ).rejects.toThrow(/safe integer range/)
  })

  test('surfaces a node that returns no transaction', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => ({})),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    const account = {
      getAddress: async () => 'TSender',
      sendTransaction: async () => ({ hash: 't' }),
    }
    await expect(tronAdapter.send(account, { tx: TX }, { tronWeb })).rejects.toThrow(
      /no transaction for the order call/
    )
  })
})

describe('tronAdapter.getRequiredApproval', () => {
  const account = { getAddress: async () => 'TSender' }

  test('returns the approval when the allowance is short', async () => {
    const tronWeb = fakeTronWeb()
    const out = await tronAdapter.getRequiredApproval(account, 'TUsdt', 'TSpender', 500n, {
      tronWeb,
    })
    expect(tronWeb.transactionBuilder.triggerConstantContract).toHaveBeenCalledWith(
      'TUsdt',
      'allowance(address,address)',
      {},
      [
        { type: 'address', value: 'TSender' },
        { type: 'address', value: 'TSpender' },
      ],
      'TSender'
    )
    expect(out).toEqual({ token: 'TUsdt', spender: 'TSpender', amount: 500n })
  })

  test('returns null when the allowance already covers the amount', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [word(1000n)] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    expect(
      await tronAdapter.getRequiredApproval(account, 'TUsdt', 'TSpender', 500n, { tronWeb })
    ).toBeNull()
  })

  test('returns null for native TRX in either spelling, without an allowance call', async () => {
    const tronWeb = fakeTronWeb()
    for (const native of [
      '',
      '0x0000000000000000000000000000000000000000',
      'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    ]) {
      expect(
        await tronAdapter.getRequiredApproval(account, native, 'TSpender', 500n, { tronWeb })
      ).toBeNull()
    }
    expect(tronWeb.transactionBuilder.triggerConstantContract).not.toHaveBeenCalled()
  })

  test('throws when allowance() returns nothing', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    await expect(
      tronAdapter.getRequiredApproval(account, 'TUsdt', 'TSpender', 500n, { tronWeb })
    ).rejects.toThrow(/allowance\(\) returned no result/)
  })
})

describe('tronAdapter.simulate', () => {
  test('quotes the fee and reports no approval needed', async () => {
    const tronWeb = fakeTronWeb({
      triggerConstantContract: vi.fn(async () => ({ constant_result: [word(1000n)] })),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    const account = {
      getAddress: async () => 'TSender',
      quoteSendTransaction: vi.fn(async () => ({ fee: 27_000_000n, activationFee: 0n })),
    }
    const out = await tronAdapter.simulate(
      account,
      { tx: TX },
      {
        tronWeb,
        token: 'TUsdt',
        amount: 500n,
      }
    )
    expect(account.quoteSendTransaction).toHaveBeenCalledWith(UNSIGNED)
    expect(out).toEqual({
      tx: TX,
      feeEstimate: 27_000_000n,
      requiredApproval: null,
      valid: true,
    })
  })

  test('spender defaults to the order tx target', async () => {
    const tronWeb = fakeTronWeb()
    const account = { getAddress: async () => 'TSender' }
    const out = await tronAdapter.simulate(
      account,
      { tx: TX },
      { tronWeb, token: 'TUsdt', amount: 500n }
    )
    expect(out.requiredApproval).toEqual({
      token: 'TUsdt',
      spender: 'TRegistryAddress',
      amount: 500n,
    })
    expect(out.feeEstimate).toBeNull()
  })

  test('a reverting build reports valid:false with the reason, not a throw', async () => {
    const tronWeb = fakeTronWeb({
      triggerSmartContract: vi.fn(async () => {
        throw new Error('REVERT opcode executed')
      }),
    } as unknown as Partial<TronWebLike['transactionBuilder']>)
    const account = { getAddress: async () => 'TSender' }
    const out = await tronAdapter.simulate(account, { tx: TX }, { tronWeb })
    expect(out.valid).toBe(false)
    expect(out.reason).toMatch(/REVERT/)
    expect(out.feeEstimate).toBeNull()
  })
})

describe('buildTronApproval', () => {
  test('produces a TronSmartContractCall the WDK account accepts directly', () => {
    expect(buildTronApproval({ token: 'TUsdt', spender: 'TSpender', amount: 500n })).toEqual({
      contractAddress: 'TUsdt',
      functionSelector: 'approve(address,uint256)',
      parameters: [
        { type: 'address', value: 'TSpender' },
        { type: 'uint256', value: '500' },
      ],
      options: { feeLimit: 100_000_000 },
    })
  })

  test('feeLimit is overridable', () => {
    expect(
      buildTronApproval({ token: 'TUsdt', spender: 'TSpender', amount: 1 }, { feeLimit: 10 })
        .options
    ).toEqual({ feeLimit: 10 })
  })
})

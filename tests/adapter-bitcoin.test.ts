import { describe, test, expect, vi } from 'vitest'
import { bitcoinAdapter } from '../src/chain-adapters/bitcoin.js'

describe('bitcoinAdapter', () => {
  test('send signs to deposit address and returns hex', async () => {
    const account = {
      getAddress: vi.fn(() => 'bc1qtest'),
      signTransaction: vi.fn(async () => ({ toHex: () => 'deadbeef', getId: () => 'txid1' })),
    }
    const out = await bitcoinAdapter.send(account, { address: 'bc1q', amount: 100000n }, { feeRate: 5 })
    expect(account.signTransaction).toHaveBeenCalledWith({ to: 'bc1q', value: 100000n, feeRate: 5 })
    expect(out).toEqual({ txid: 'txid1', hex: 'deadbeef' })
  })

  test('send throws NOT_SUPPORTED when signTransaction is missing', async () => {
    const account = { getAddress: vi.fn(() => 'bc1q') }
    await expect(
      bitcoinAdapter.send(account as Parameters<typeof bitcoinAdapter.send>[0], { address: 'bc1q', amount: 100000n }, {})
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  test('deriveAddress returns account.getAddress()', async () => {
    const account = { getAddress: vi.fn(() => 'bc1qtest') }
    const addr = await bitcoinAdapter.deriveAddress(account)
    expect(addr).toBe('bc1qtest')
  })
})

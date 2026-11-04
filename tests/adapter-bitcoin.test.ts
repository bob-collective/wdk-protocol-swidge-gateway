import { describe, test, expect, vi } from 'vitest'
import { Transaction, address as btcAddress, networks } from 'bitcoinjs-lib'
import { bitcoinAdapter } from '../src/chain-adapters/bitcoin.js'

const DEPOSIT_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

function buildTxHex(addr: string, satoshis: bigint): { hex: string; txid: string } {
  const tx = new Transaction()
  tx.addInput(Buffer.alloc(32, 0), 0)
  const script = btcAddress.toOutputScript(addr, networks.bitcoin)
  tx.addOutput(script, Number(satoshis))
  return { hex: tx.toHex(), txid: tx.getId() }
}

describe('bitcoinAdapter', () => {
  test('send signs to deposit address and returns hex', async () => {
    const { hex, txid } = buildTxHex(DEPOSIT_ADDR, 100000n)
    const account = {
      getAddress: vi.fn(() => 'bc1qtest'),
      signTransaction: vi.fn(async () => hex),
    }
    const out = await bitcoinAdapter.send(account, { address: DEPOSIT_ADDR, amount: 100000n }, { feeRate: 5 })
    expect(account.signTransaction).toHaveBeenCalledWith({ to: DEPOSIT_ADDR, value: 100000n, feeRate: 5 })
    expect(out).toEqual({ txid, hex })
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

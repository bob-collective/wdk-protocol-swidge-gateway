/* eslint-env jest */
'use strict'

import { jest } from '@jest/globals'
import { bitcoinAdapter } from '../src/chain-adapters/bitcoin.js'

test('send signs to deposit address and returns hex', async () => {
  const account = { signTransaction: jest.fn(async () => ({ toHex: () => 'deadbeef', getId: () => 'txid1' })) }
  const out = await bitcoinAdapter.send(account, { kind: 'btc', address: 'bc1q', amount: 100000n }, { feeRate: 5 })
  expect(account.signTransaction).toHaveBeenCalledWith({ to: 'bc1q', value: 100000n, feeRate: 5 })
  expect(out).toEqual({ txid: 'txid1', hex: 'deadbeef' })
})

test('send throws NOT_SUPPORTED when signTransaction is missing', async () => {
  const account = {}
  await expect(
    bitcoinAdapter.send(account, { kind: 'btc', address: 'bc1q', amount: 100000n }, {})
  ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
})

test('deriveAddress returns account.getAddress()', async () => {
  const account = { getAddress: jest.fn(() => 'bc1qtest') }
  const addr = await bitcoinAdapter.deriveAddress(account)
  expect(addr).toBe('bc1qtest')
})

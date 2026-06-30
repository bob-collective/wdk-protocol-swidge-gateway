/* eslint-env jest */
'use strict'

import { evmAdapter } from '../src/chain-adapters/evm.js'
import { jest } from '@jest/globals'

test('EOA send passes single tx', async () => {
  const account = { isErc4337: false, sendTransaction: jest.fn(async () => ({ hash: '0xtx' })) }
  const out = await evmAdapter.send(account, { kind: 'evm', tx: { to: '0xto', data: '0xd', value: '0' } }, {})
  expect(account.sendTransaction).toHaveBeenCalledWith({ to: '0xto', data: '0xd', value: '0' })
  expect(out).toEqual({ txid: '0xtx' })
})

test('ERC-4337 send passes array + config', async () => {
  const account = { isErc4337: true, sendTransaction: jest.fn(async () => ({ hash: '0xaa' })) }
  await evmAdapter.send(account, { kind: 'evm', tx: { to: '0xto', data: '0xd', value: '0' } },
    { aaConfig: { paymasterToken: { address: '0xpm' } } })
  expect(account.sendTransaction).toHaveBeenCalledWith([{ to: '0xto', data: '0xd', value: '0' }],
    { paymasterToken: { address: '0xpm' } })
})

test('getRequiredApproval returns null when allowance sufficient', async () => {
  const account = { getAllowance: jest.fn(async () => 1000n) }
  expect(await evmAdapter.getRequiredApproval(account, '0xtok', '0xspender', 500n)).toBeNull()
})

test('getRequiredApproval returns the approval when allowance is insufficient', async () => {
  const account = { getAllowance: jest.fn(async () => 100n) }
  const out = await evmAdapter.getRequiredApproval(account, '0xtok', '0xspender', 500n)
  expect(account.getAllowance).toHaveBeenCalledWith('0xtok', '0xspender')
  expect(out).toEqual({ token: '0xtok', spender: '0xspender', amount: 500n })
  expect(typeof out.amount).toBe('bigint')
})

test('getRequiredApproval returns null for native/zero-address and empty token (no allowance call)', async () => {
  const account = { getAllowance: jest.fn(async () => 0n) }
  expect(await evmAdapter.getRequiredApproval(account, '0x0000000000000000000000000000000000000000', '0xspender', 500n)).toBeNull()
  expect(await evmAdapter.getRequiredApproval(account, '', '0xspender', 500n)).toBeNull()
  expect(account.getAllowance).not.toHaveBeenCalled()
})

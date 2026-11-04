import { describe, test, expect, vi } from 'vitest'
import { MAX_UINT256 } from '../src/allowance-holder.js'
import { evmAdapter } from '../src/chain-adapters/evm.js'

describe('evmAdapter', () => {
  test('EOA send passes single tx', async () => {
    const account = {
      isErc4337: false,
      sendTransaction: vi.fn(async () => ({ hash: '0xtx' })),
    }
    const out = await evmAdapter.send(
      account,
      { kind: 'evm', tx: { to: '0xto', data: '0xd', value: '0' } },
      {}
    )
    expect(account.sendTransaction).toHaveBeenCalledWith({ to: '0xto', data: '0xd', value: '0' })
    expect(out).toEqual({ txid: '0xtx' })
  })

  test('ERC-4337 send passes array + config', async () => {
    const account = {
      isErc4337: true,
      sendTransaction: vi.fn(async () => ({ hash: '0xaa' })),
    }
    await evmAdapter.send(
      account,
      { kind: 'evm', tx: { to: '0xto', data: '0xd', value: '0' } },
      { aaConfig: { paymasterToken: { address: '0xpm' } } }
    )
    expect(account.sendTransaction).toHaveBeenCalledWith(
      [{ to: '0xto', data: '0xd', value: '0' }],
      { paymasterToken: { address: '0xpm' } }
    )
  })

  test('getRequiredApproval returns null when allowance sufficient', async () => {
    const account = { getAllowance: vi.fn(async () => 1000n) }
    expect(await evmAdapter.getRequiredApproval(account, '0xtok', '0xspender', 500n)).toBeNull()
  })

  test('getRequiredApproval returns the approval when allowance is insufficient', async () => {
    const account = { getAllowance: vi.fn(async () => 100n) }
    const out = await evmAdapter.getRequiredApproval(account, '0xtok', '0xspender', 500n)
    expect(account.getAllowance).toHaveBeenCalledWith('0xtok', '0xspender')
    expect(out).toEqual({ token: '0xtok', spender: '0xspender', amount: MAX_UINT256 })
    expect(typeof out!.amount).toBe('bigint')
  })

  describe('USDT on Ethereum allowance reset', () => {
    const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

    test('flags resetRequired when a non-zero allowance is below the amount', async () => {
      const account = { getAllowance: vi.fn(async () => 100n) }
      const out = await evmAdapter.getRequiredApproval(account, USDT, '0xspender', 500n, {
        chain: 'ethereum',
      })
      expect(out).toEqual({
        token: USDT,
        spender: '0xspender',
        amount: MAX_UINT256,
        resetRequired: true,
      })
    })

    test.each([
      ['zero allowance', 0n, 'ethereum', USDT],
      ['another chain', 100n, 'base', USDT],
      ['no chain given', 100n, undefined, USDT],
      ['another token', 100n, 'ethereum', '0xtok'],
    ])('no reset for %s', async (_label, allowance, chain, token) => {
      const account = { getAllowance: vi.fn(async () => allowance) }
      const out = await evmAdapter.getRequiredApproval(account, token, '0xspender', 500n, { chain })
      expect(out).not.toBeNull()
      expect(out!.resetRequired).toBeUndefined()
    })

    test('simulate carries resetRequired through requiredApproval', async () => {
      const account = {
        getAllowance: vi.fn(async () => 100n),
        quoteSendTransaction: vi.fn(async () => ({ fee: 1n })),
        sendTransaction: vi.fn(),
      }
      const out = await evmAdapter.simulate(
        account,
        { tx: { to: '0xspender', data: '0xd', value: '0' } },
        { token: USDT, amount: 500n, chain: 'ethereum' }
      )
      expect(out.requiredApproval?.resetRequired).toBe(true)
    })
  })

  test('getRequiredApproval returns null for native/zero-address and empty token (no allowance call)', async () => {
    const account = { getAllowance: vi.fn(async () => 0n) }
    expect(
      await evmAdapter.getRequiredApproval(
        account,
        '0x0000000000000000000000000000000000000000',
        '0xspender',
        500n
      )
    ).toBeNull()
    expect(await evmAdapter.getRequiredApproval(account, '', '0xspender', 500n)).toBeNull()
    expect(account.getAllowance).not.toHaveBeenCalled()
  })
})

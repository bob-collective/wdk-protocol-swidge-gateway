import { describe, test, expect, vi } from 'vitest'
import { assertAllowanceHolderSpender, MAX_UINT256 } from '../src/allowance-holder.js'
import { GatewaySwidge } from '../src/gateway-swidge.js'
import type { GatewayClient } from '../src/gateway-client.js'

const CANONICAL = '0x0000000000001fF3684f28c67538d4D072C22734'

describe('assertAllowanceHolderSpender', () => {
  test('MAX_UINT256 is 2^256 - 1', () => {
    expect(MAX_UINT256).toBe(2n ** 256n - 1n)
  })

  test.each([
    ['base', CANONICAL],
    ['ETHEREUM', CANONICAL.toLowerCase()],
    ['bob', '0x8fd545b348e84deb145f0179a00c671f0b9519c3'],
    ['tron', 'TAfbit1ENsRmtZbPQfYU3srURpfYuWYS7K'],
    ['tron', '0x07a39ae4c49dee86e892450b20881f32cd5d500d'],
  ])('accepts the %s AllowanceHolder %s', (chain, spender) => {
    expect(() => assertAllowanceHolderSpender(chain, spender)).not.toThrow()
  })

  test.each([
    ['base', '0x8fd545b348e84deb145f0179a00c671f0b9519c3', /expected the AllowanceHolder/],
    ['bob', CANONICAL, /expected the AllowanceHolder/],
    ['tron', 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', /expected the AllowanceHolder/],
    ['base', 'not-an-address', /expected the AllowanceHolder/],
    ['solana', CANONICAL, /no known AllowanceHolder for chain "solana"/],
  ])('rejects %s spender %s', (chain, spender, expected) => {
    expect(() => assertAllowanceHolderSpender(chain, spender)).toThrow(expected)
  })
})

describe('GatewaySwidge unbounded approvals', () => {
  const offrampClient = (to: string): GatewayClient =>
    ({
      getQuote: vi.fn(async () => ({
        offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' } },
      })),
      createOrder: vi.fn(async () => ({
        offramp: { order_id: 'o', tx: { to, data: '0xdata', value: '0' } },
      })),
      registerTx: vi.fn(),
    }) as unknown as GatewayClient

  const route = {
    fromToken: '0xtok',
    toToken: 'BTC',
    toChain: 'bitcoin',
    recipient: 'bc1qrcpt',
    fromTokenAmount: 500n,
  }

  test('getRequiredApproval refuses an unbounded approval to a non-AllowanceHolder spender', async () => {
    const account = { getAddress: async () => '0xsender', getAllowance: vi.fn(async () => 0n) }
    const sw = new GatewaySwidge(account, { fromChain: 'base', client: offrampClient('0xevil') })
    await expect(sw.getRequiredApproval(route)).rejects.toThrow(
      /refusing to approve 0xevil on chain "base"/
    )
  })

  test('getRequiredApproval flags a USDT-on-Ethereum allowance reset', async () => {
    const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    const account = { getAddress: async () => '0xsender', getAllowance: vi.fn(async () => 100n) }
    const sw = new GatewaySwidge(account, {
      fromChain: 'ethereum',
      client: offrampClient(CANONICAL),
    })
    expect(await sw.getRequiredApproval({ ...route, fromToken: usdt })).toEqual({
      token: usdt,
      spender: CANONICAL,
      amount: MAX_UINT256,
      resetRequired: true,
    })
  })

  test('no approval needed → no spender check (allowance already covers the order)', async () => {
    const account = { getAddress: async () => '0xsender', getAllowance: vi.fn(async () => 500n) }
    const sw = new GatewaySwidge(account, { fromChain: 'base', client: offrampClient('0xother') })
    expect(await sw.getRequiredApproval(route)).toBeNull()
  })

  test('simulateSwidge refuses to report an approval for a non-AllowanceHolder spender', async () => {
    const account = {
      getAddress: async () => '0xsender',
      getAllowance: vi.fn(async () => 0n),
      quoteSendTransaction: vi.fn(async () => ({ fee: 1n })),
    }
    const sw = new GatewaySwidge(account, { fromChain: 'base', client: offrampClient('0xevil') })
    await expect(sw.simulateSwidge(route)).rejects.toThrow(/refusing to approve 0xevil/)
  })
})

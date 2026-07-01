/**
 * Tests for simulate() adapter methods and GatewaySwidge.simulateSwidge().
 *
 * BTC output-address match validation uses real bitcoinjs-lib:
 *   - Build a Transaction that pays a known bech32 address via `address.toOutputScript`.
 *   - The mock signTransaction returns this tx hex.
 *   - bitcoinAdapter.simulate() parses it with `Transaction.fromHex` and checks outputs.
 */
import { describe, test, expect, vi } from 'vitest'
import { Transaction, address as btcAddress, networks } from 'bitcoinjs-lib'
import { bitcoinAdapter } from '../src/chain-adapters/bitcoin.js'
import { evmAdapter } from '../src/chain-adapters/evm.js'
import { GatewaySwidge } from '../src/gateway-swidge.js'
import type { GatewayClient } from '../src/gateway-client.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

const DEPOSIT_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' // known P2WPKH mainnet address
const AMOUNT = 100_000n // satoshis

/**
 * Build a minimal (unsigned-inputs) Transaction that pays DEPOSIT_ADDR with AMOUNT.
 * Inputs don't need valid scripts for the output-validation check.
 */
function buildTxPayingDeposit(addr: string, satoshis: bigint): { hex: string; txid: string } {
  const tx = new Transaction()
  tx.addInput(Buffer.alloc(32, 0), 0) // dummy input
  const script = btcAddress.toOutputScript(addr, networks.bitcoin)
  tx.addOutput(script, Number(satoshis))
  return { hex: tx.toHex(), txid: tx.getId() }
}

function fakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    getQuote: vi.fn(async () => ({
      onramp: { inputAmount: { amount: '100000' }, outputAmount: { amount: '99000' }, fees: {} },
    })),
    createOrder: vi.fn(async () => ({
      onramp: { order_id: 'sim-order-1', address: DEPOSIT_ADDR, inputAmount: { amount: '100000' } },
    })),
    registerTx: vi.fn(async () => ({})),
    getOrder: vi.fn(async () => ({ status: { success: { received_tokens: [] } } })),
    getRoutes: vi.fn(async () => []),
    ...overrides,
  } as unknown as GatewayClient
}

function fakeEvmClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    getQuote: vi.fn(async () => ({
      offramp: { inputAmount: { amount: '1000' }, outputAmount: { amount: '900' }, fees: {} },
    })),
    createOrder: vi.fn(async () => ({
      offramp: { order_id: 'sim-order-evm', tx: { to: '0xspender', data: '0xdata', value: '0' } },
    })),
    registerTx: vi.fn(async () => ({})),
    getOrder: vi.fn(async () => ({ status: { success: { received_tokens: [] } } })),
    getRoutes: vi.fn(async () => []),
    ...overrides,
  } as unknown as GatewayClient
}

// ─── bitcoinAdapter.simulate() ────────────────────────────────────────────────

describe('bitcoinAdapter.simulate()', () => {
  test('valid: true when output pays deposit address with exact amount', async () => {
    const { hex, txid } = buildTxPayingDeposit(DEPOSIT_ADDR, AMOUNT)
    const account = {
      getAddress: vi.fn(() => 'bc1qtest'),
      signTransaction: vi.fn(async () => ({ toHex: () => hex, getId: () => txid })),
    }
    const result = await bitcoinAdapter.simulate(account, { address: DEPOSIT_ADDR, amount: AMOUNT }, {})
    expect(account.signTransaction).toHaveBeenCalledWith({ to: DEPOSIT_ADDR, value: AMOUNT, feeRate: undefined })
    expect(result.valid).toBe(true)
    expect(result.paidToDeposit).toBe(AMOUNT)
    expect(result.signedTxHex).toBe(hex)
    expect(result.txid).toBe(txid)
  })

  test('valid: false when output underpays deposit address', async () => {
    const lessAmount = AMOUNT - 1n
    const { hex, txid } = buildTxPayingDeposit(DEPOSIT_ADDR, lessAmount)
    const account = {
      getAddress: vi.fn(() => 'bc1qtest'),
      signTransaction: vi.fn(async () => ({ toHex: () => hex, getId: () => txid })),
    }
    const result = await bitcoinAdapter.simulate(account, { address: DEPOSIT_ADDR, amount: AMOUNT }, {})
    expect(result.valid).toBe(false)
    expect(result.paidToDeposit).toBe(lessAmount)
  })

  test('throws NOT_SUPPORTED when signTransaction is missing', async () => {
    const account = { getAddress: vi.fn(() => 'bc1qtest') }
    await expect(
      bitcoinAdapter.simulate(account as Parameters<typeof bitcoinAdapter.simulate>[0], { address: DEPOSIT_ADDR, amount: AMOUNT }, {})
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})

// ─── evmAdapter.simulate() ────────────────────────────────────────────────────

describe('evmAdapter.simulate()', () => {
  test('valid: true when quoteSendTransaction resolves, requiredApproval null (allowance sufficient)', async () => {
    const account = {
      getAllowance: vi.fn(async () => 2000n),
      sendTransaction: vi.fn(),
      quoteSendTransaction: vi.fn(async () => ({ fee: 21000n })),
    }
    const payload = { kind: 'evm' as const, tx: { to: '0xspender', data: '0xd', value: '0' } }
    const result = await evmAdapter.simulate(account, payload, { token: '0xtok', spender: '0xspender', amount: 1000n })
    expect(result.valid).toBe(true)
    expect(result.gasEstimate).toBe(21000n)
    expect(result.requiredApproval).toBeNull()
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('valid: false when quoteSendTransaction throws (revert), reason captured, no rethrow', async () => {
    const account = {
      getAllowance: vi.fn(async () => 0n),
      sendTransaction: vi.fn(),
      quoteSendTransaction: vi.fn(async () => { throw new Error('execution reverted: insufficient allowance') }),
    }
    const payload = { kind: 'evm' as const, tx: { to: '0xspender', data: '0xd', value: '0' } }
    const result = await evmAdapter.simulate(account, payload, { token: '0xtok', spender: '0xspender', amount: 1000n })
    expect(result.valid).toBe(false)
    expect(result.gasEstimate).toBeNull()
    expect(result.reason).toContain('insufficient allowance')
    expect(result.requiredApproval).toEqual({ token: '0xtok', spender: '0xspender', amount: 1000n })
    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('requiredApproval present when allowance is insufficient and quoteSendTransaction resolves', async () => {
    const account = {
      getAllowance: vi.fn(async () => 50n),
      sendTransaction: vi.fn(),
      quoteSendTransaction: vi.fn(async () => ({ fee: 21000n })),
    }
    const payload = { kind: 'evm' as const, tx: { to: '0xspender', data: '0xd', value: '0' } }
    const result = await evmAdapter.simulate(account, payload, { token: '0xtok', spender: '0xspender', amount: 1000n })
    expect(result.valid).toBe(true)
    expect(result.requiredApproval).toEqual({ token: '0xtok', spender: '0xspender', amount: 1000n })
  })

  test('throws NOT_SUPPORTED when quoteSendTransaction is missing', async () => {
    const account = {
      getAllowance: vi.fn(async () => 0n),
      sendTransaction: vi.fn(),
    }
    const payload = { kind: 'evm' as const, tx: { to: '0xspender', data: '0xd', value: '0' } }
    await expect(
      evmAdapter.simulate(account as Parameters<typeof evmAdapter.simulate>[0], payload, {})
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})

// ─── GatewaySwidge.simulateSwidge() ──────────────────────────────────────────

describe('GatewaySwidge.simulateSwidge()', () => {
  test('onramp simulate: valid, paidToDeposit ≥ amount, registerTx never called', async () => {
    const { hex, txid } = buildTxPayingDeposit(DEPOSIT_ADDR, AMOUNT)
    const account = {
      getAddress: async () => 'bc1qcaller',
      signTransaction: async () => ({ toHex: () => hex, getId: () => txid }),
    }
    const client = fakeClient()
    const sw = new GatewaySwidge(account, { fromChain: 'bitcoin', client })
    const result = await sw.simulateSwidge({
      fromToken: 'BTC',
      toToken: 'USDT',
      toChain: 'base',
      recipient: '0xrcpt',
      fromTokenAmount: AMOUNT,
    })
    expect(result.broadcast).toBe(false)
    expect(result.orderId).toBe('sim-order-1')
    expect(result.variant).toBe('onramp')
    expect('onramp' in result).toBe(true)
    if ('onramp' in result) {
      expect(result.onramp.valid).toBe(true)
      expect(result.onramp.paidToDeposit).toBeGreaterThanOrEqual(AMOUNT)
    }
    expect(client.registerTx).not.toHaveBeenCalled()
  })

  test('offramp simulate (approval sufficient): valid, sendTransaction never called', async () => {
    const account = {
      getAddress: async () => '0xsender',
      getAllowance: vi.fn(async () => 9999n),
      sendTransaction: vi.fn(),
      quoteSendTransaction: vi.fn(async () => ({ fee: 21000n })),
    }
    const client = fakeEvmClient()
    const sw = new GatewaySwidge(account, { fromChain: 'base', client })
    const result = await sw.simulateSwidge({
      fromToken: '0xtok',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000n,
    })
    expect(result.broadcast).toBe(false)
    expect(result.variant).toBe('offramp')
    expect('evm' in result).toBe(true)
    if ('evm' in result) {
      expect(result.evm.valid).toBe(true)
      expect(result.evm.gasEstimate).toBe(21000n)
      expect(result.evm.requiredApproval).toBeNull()
    }
    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(client.registerTx).not.toHaveBeenCalled()
  })

  test('offramp simulate (approval missing / revert): valid: false, reason set, no throw', async () => {
    const account = {
      getAddress: async () => '0xsender',
      getAllowance: vi.fn(async () => 0n),
      sendTransaction: vi.fn(),
      quoteSendTransaction: vi.fn(async () => { throw new Error('execution reverted') }),
    }
    const client = fakeEvmClient()
    const sw = new GatewaySwidge(account, { fromChain: 'base', client })
    // Must NOT throw
    const result = await sw.simulateSwidge({
      fromToken: '0xtok',
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: 'bc1qrcpt',
      fromTokenAmount: 1000n,
    })
    expect(result.broadcast).toBe(false)
    expect('evm' in result).toBe(true)
    if ('evm' in result) {
      expect(result.evm.valid).toBe(false)
      expect(result.evm.reason).toBeTruthy()
      expect(result.evm.requiredApproval).toEqual({ token: '0xtok', spender: '0xspender', amount: 1000n })
    }
    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(client.registerTx).not.toHaveBeenCalled()
  })
})

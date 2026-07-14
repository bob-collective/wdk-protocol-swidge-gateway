import { describe, test, expect } from 'vitest'
import { address as btcAddress, networks } from 'bitcoinjs-lib'

// The gateway hands back a deposit address and the BTC adapter converts it to an output script
// to verify how much the signed transaction actually pays. When that address is taproot (P2TR),
// bitcoinjs-lib needs an ECC library registered via initEccLib() or it throws.
//
// This module used to get that initialization for free: @tetherto/wdk-wallet-btc@1.0.0-beta.10
// imported bitcoinjs-lib 6.1.7 — the exact version pinned here — so pnpm deduped it to one
// instance, and wallet-btc's own `initEccLib(ecc)` at import time initialized *our* copy too.
// wallet-btc 1.0.0-beta.11 moved to bitcoinjs-lib 7.x, which splits the copies and silently
// removes that side effect, breaking every taproot deposit address.
//
// So: importing our own module must be sufficient to parse a taproot address. This test
// deliberately does NOT import any wdk-wallet package — that is the whole point.
describe('taproot support does not depend on wdk-wallet-btc being loaded', () => {
  // Mainnet P2TR (bech32m) address.
  const P2TR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'

  test('the bitcoin adapter registers an ECC library on import', async () => {
    await import('../src/chain-adapters/bitcoin.js')

    expect(() => btcAddress.toOutputScript(P2TR, networks.bitcoin)).not.toThrow()
  })

  test('a taproot deposit address converts to a 34-byte v1 witness program', async () => {
    await import('../src/chain-adapters/bitcoin.js')

    const script = btcAddress.toOutputScript(P2TR, networks.bitcoin)
    // OP_1 (0x51) + PUSH_32 (0x20) + 32-byte x-only pubkey
    expect(script.length).toBe(34)
    expect(script[0]).toBe(0x51)
    expect(script[1]).toBe(0x20)
  })
})

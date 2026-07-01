/**
 * Gateway validation suite — mainnet, no swap.
 *
 * Validates quote responses and sign/simulate paths (GatewaySwidge.quoteSwidge +
 * GatewaySwidge.simulateSwidge) without broadcasting any transaction.
 *
 * Gate: requires TEST_SEED in the environment. Without it the entire describe
 * block is skipped and the test runner exits green (0 failed).
 *
 * Run locally:
 *   op run --env-file=.env.op -- pnpm exec vitest run tests/integration
 *
 * Environment variables:
 *   TEST_SEED       — BIP-39 mnemonic (required)
 *   EVM_RPC_URL     — JSON-RPC endpoint for Ethereum (default: https://eth.llamarpc.com)
 *   AMOUNT_SATS     — BTC onramp amount in satoshis (default: 30000, ~$30 — fits a $50 test wallet with fee headroom)
 *   AMOUNT_USDT     — USDT offramp amount in smallest unit (default: 50000000 = 50 USDT)
 */

import { describe, test, expect } from 'vitest'

const RUN = !!process.env.TEST_SEED

// All test work is inside the conditional describe so that, when TEST_SEED is absent,
// no WDK modules are imported and no network calls are attempted.
;(RUN ? describe : describe.skip)(
  'gateway validation (mainnet, no swap)',
  { timeout: 120_000 },
  () => {
    const USDT_ETHEREUM = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    const BTC_ZERO = '0x0000000000000000000000000000000000000000'
    const EVM_RPC = process.env.EVM_RPC_URL ?? 'https://eth.llamarpc.com'
    const AMOUNT_SATS = BigInt(process.env.AMOUNT_SATS ?? '30000')
    const AMOUNT_USDT = BigInt(process.env.AMOUNT_USDT ?? '50000000')

    // Lazily resolved — only populated once the first test runs.
    let btcAddress: string
    let evmAddress: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let btcAccount: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let evmAccount: any

    // Shared setup: derive accounts from the seed once before all tests.
    // We do this inside a test rather than beforeAll so that import errors surface
    // as a clear test failure rather than a mysterious setup error.
    test('setup: derive BTC + EVM accounts from TEST_SEED', async () => {
      const seed = process.env.TEST_SEED!
      const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
      const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')

      const btcWallet = new WalletManagerBtc(seed, { network: 'bitcoin' })
      btcAccount = await btcWallet.getAccount(0)
      btcAddress = await btcAccount.getAddress()

      const evmWallet = new WalletManagerEvm(seed, { provider: EVM_RPC })
      evmAccount = await evmWallet.getAccount(0)
      evmAddress = await evmAccount.getAddress()

      expect(btcAddress).toMatch(/^bc1/)
      expect(evmAddress).toMatch(/^0x/)
    })

    // ── quoteSwidge conformance ──────────────────────────────────────────────

    test('quoteSwidge: onramp BTC → USDT@ethereum', async () => {
      const { GatewaySwidge } = await import('../../src/index.js')
      const sw = new GatewaySwidge(btcAccount, { fromChain: 'bitcoin' })
      const quote = await sw.quoteSwidge({
        fromToken: BTC_ZERO,
        toToken: USDT_ETHEREUM,
        toChain: 'ethereum',
        recipient: evmAddress,
        fromTokenAmount: AMOUNT_SATS,
      })
      expect(quote.toTokenAmount).toBeGreaterThan(0n)
      expect(Array.isArray(quote.fees)).toBe(true)
    })

    test('quoteSwidge: offramp USDT@ethereum → BTC', async () => {
      const { GatewaySwidge } = await import('../../src/index.js')
      const sw = new GatewaySwidge(evmAccount, { fromChain: 'ethereum' })
      const quote = await sw.quoteSwidge({
        fromToken: USDT_ETHEREUM,
        toToken: BTC_ZERO,
        toChain: 'bitcoin',
        recipient: btcAddress,
        fromTokenAmount: AMOUNT_USDT,
      })
      expect(quote.toTokenAmount).toBeGreaterThan(0n)
      expect(Array.isArray(quote.fees)).toBe(true)
    })

    // ── simulateSwidge onramp ────────────────────────────────────────────────

    test('simulateSwidge: onramp BTC → USDT@ethereum — broadcast false, paidToDeposit ≥ AMOUNT_SATS', async () => {
      const { GatewaySwidge } = await import('../../src/index.js')
      const sw = new GatewaySwidge(btcAccount, { fromChain: 'bitcoin' })
      const sim = await sw.simulateSwidge({
        fromToken: BTC_ZERO,
        toToken: USDT_ETHEREUM,
        toChain: 'ethereum',
        recipient: evmAddress,
        fromTokenAmount: AMOUNT_SATS,
      })
      expect(sim.broadcast).toBe(false)
      expect('onramp' in sim).toBe(true)
      if (!('onramp' in sim)) return
      expect(sim.onramp.valid).toBe(true)
      expect(sim.onramp.paidToDeposit).toBeGreaterThanOrEqual(AMOUNT_SATS)
    })

    // ── simulateSwidge offramp ───────────────────────────────────────────────

    test(
      'simulateSwidge: offramp USDT@ethereum → BTC — broadcast false; valid or requiredApproval present',
      async () => {
        const { GatewaySwidge } = await import('../../src/index.js')
        const sw = new GatewaySwidge(evmAccount, { fromChain: 'ethereum' })
        const sim = await sw.simulateSwidge({
          fromToken: USDT_ETHEREUM,
          toToken: BTC_ZERO,
          toChain: 'bitcoin',
          recipient: btcAddress,
          fromTokenAmount: AMOUNT_USDT,
        })
        expect(sim.broadcast).toBe(false)
        expect('evm' in sim).toBe(true)
        if (!('evm' in sim)) return

        // A missing standing approval surfaces as valid:false + requiredApproval present.
        // This is a legitimate outcome when the account has not pre-approved the spender.
        // The test accepts EITHER a fully-valid simulation OR the expected "approval needed" path.
        const { valid, requiredApproval } = sim.evm
        const approvalNeeded = !valid && requiredApproval !== null

        // At least one of the two valid outcomes must hold:
        //   (a) simulation succeeded with valid: true, or
        //   (b) approval is needed (valid: false, requiredApproval non-null).
        // Anything else (e.g. a hard network error yielding valid:false + requiredApproval:null)
        // is a genuine failure.
        expect(valid || approvalNeeded).toBe(true)

        if (!valid && approvalNeeded) {
          // Approval-needed path: document that this is expected without Tenderly state-override.
          expect(requiredApproval).toMatchObject({
            token: USDT_ETHEREUM,
            spender: expect.stringMatching(/^0x/),
            amount: expect.any(BigInt),
          })
        }
      }
    )
  }
)

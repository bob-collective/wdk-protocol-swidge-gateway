/**
 * FUNDED e2e offramp script — USDT on Ethereum → BTC
 *
 * ⚠ THIS SCRIPT MOVES REAL FUNDS. ⚠
 * Run ONLY after the preflight harness passes.
 * Both guard env vars MUST be set:
 *   GATEWAY_E2E=1
 *   I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes
 *
 * Required env vars:
 *   EVM_SEED          — BIP-39 seed phrase for the EVM USDT sender account
 *   BTC_ADDRESS       — destination BTC address for received sats
 *   AMOUNT_USDT       — USDT amount in 6dp (default 50000000 = 50 USDT)
 *
 * Optional env vars:
 *   GATEWAY_API_URL   — override API URL
 *   GATEWAY_API_KEY   — override API key
 *   EVM_PROVIDER      — Ethereum JSON-RPC URL (default https://eth.drpc.org)
 *   POLL_INTERVAL_MS  — polling interval (default 15000)
 *   POLL_TIMEOUT_MS   — max wait time (default 1800000 = 30 min)
 *
 * USDT approval notes:
 *   USDT uses a non-standard ERC-20 approve() that reverts if the current
 *   allowance is non-zero. This script will:
 *     1. Check getRequiredApproval
 *     2. If approval is needed: reset allowance to 0, then set to the required amount
 *     3. Proceed to swidge
 *
 * Usage:
 *   GATEWAY_E2E=1 I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes \
 *     EVM_SEED="word1 word2 …" BTC_ADDRESS=bc1q… \
 *     node scripts/e2e-offramp.js
 */

import { GatewaySwidge } from '../index.js'

// ─── guards ───────────────────────────────────────────────────────────────────

if (process.env.GATEWAY_E2E !== '1' || process.env.I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS !== 'yes') {
  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║          ⚠  FUNDED E2E SCRIPT — REAL FUNDS AT RISK  ⚠       ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')
  console.error('This script broadcasts REAL EVM transactions on mainnet.')
  console.error('You must set BOTH of the following env vars to proceed:')
  console.error('')
  console.error('  GATEWAY_E2E=1')
  console.error('  I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes')
  console.error('')
  console.error('Run the preflight harness first: node scripts/preflight.js')
  process.exit(1)
}

if (!process.env.EVM_SEED) {
  console.error('EVM_SEED env var required (BIP-39 seed phrase for EVM sender account)')
  process.exit(1)
}

// ─── env ──────────────────────────────────────────────────────────────────────

const BTC_ZERO = '0x0000000000000000000000000000000000000000'
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

const GATEWAY_API_URL = process.env.GATEWAY_API_URL || undefined
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || undefined
const BTC_ADDRESS = process.env.BTC_ADDRESS || ''
const AMOUNT_USDT = BigInt(process.env.AMOUNT_USDT || '50000000')
const EVM_PROVIDER = process.env.EVM_PROVIDER || 'https://eth.drpc.org'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || '15000')
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || '1800000')

if (!BTC_ADDRESS) {
  console.error('BTC_ADDRESS env var required (recipient BTC address for sats)')
  process.exit(1)
}

function sleep (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }

// ─── main ─────────────────────────────────────────────────────────────────────

async function main () {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║       BOB Gateway — FUNDED offramp: USDT-Ethereum → BTC     ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log('')
  console.log('Amount   :', AMOUNT_USDT.toString(), '(6dp =', Number(AMOUNT_USDT) / 1e6, 'USDT )')
  console.log('Recipient:', BTC_ADDRESS)
  console.log('API URL  :', GATEWAY_API_URL || '(default mainnet)')
  console.log('')

  // Build EVM account from seed
  const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')
  const evmWallet = new WalletManagerEvm(process.env.EVM_SEED, {
    provider: EVM_PROVIDER
  })
  const evmAccount = await evmWallet.getAccount(0)
  const evmAddress = await evmAccount.getAddress()
  console.log('EVM sender address:', evmAddress)

  // Build swidge config
  const cfg = { fromChain: 'ethereum' }
  if (GATEWAY_API_URL) cfg.apiUrl = GATEWAY_API_URL
  if (GATEWAY_API_KEY) cfg.apiKey = GATEWAY_API_KEY

  const sw = new GatewaySwidge(evmAccount, cfg)

  // Check required approval
  console.log('\nChecking required USDT approval…')
  const approval = await sw.getRequiredApproval({
    fromToken: USDT_ETH,
    toToken: BTC_ZERO,
    toChain: 'bitcoin',
    recipient: BTC_ADDRESS,
    fromTokenAmount: AMOUNT_USDT
  })

  if (approval === null) {
    console.log('  No approval needed (allowance already sufficient)')
  } else {
    console.log('  Approval needed:')
    console.log('    token  :', approval.token)
    console.log('    spender:', approval.spender)
    console.log('    amount :', approval.amount.toString())
    console.log('')
    console.log('  ⚠ USDT has a non-standard approve() — must reset to 0 first.')
    console.log('  Resetting USDT allowance to 0…')
    await evmAccount.approve({ token: approval.token, spender: approval.spender, amount: 0n })
    console.log('  Setting USDT allowance to', approval.amount.toString(), '…')
    await evmAccount.approve({ token: approval.token, spender: approval.spender, amount: approval.amount })
    console.log('  Approval transactions sent.')
  }

  // Preview quote
  console.log('\nFetching preview quote…')
  const preview = await sw.quoteSwidge({
    fromToken: USDT_ETH,
    toToken: BTC_ZERO,
    toChain: 'bitcoin',
    recipient: BTC_ADDRESS,
    fromTokenAmount: AMOUNT_USDT
  })
  console.log('  fromTokenAmount:', preview.fromTokenAmount.toString(), 'USDT (6dp)')
  console.log('  toTokenAmount  :', preview.toTokenAmount.toString(), 'sats')
  console.log('  fees           :', JSON.stringify(preview.fees.map(function (f) {
    return { type: f.type, amount: f.amount.toString() }
  })))
  console.log('')
  console.log('Proceeding to broadcast in 5 seconds — Ctrl+C to abort.')
  await sleep(5000)

  // Execute swidge
  console.log('\nBroadcasting EVM transaction…')
  const result = await sw.swidge({
    fromToken: USDT_ETH,
    toToken: BTC_ZERO,
    toChain: 'bitcoin',
    recipient: BTC_ADDRESS,
    fromTokenAmount: AMOUNT_USDT
  })
  console.log('  order ID  :', result.id)
  console.log('  EVM tx    :', result.hash)
  console.log('')

  // Poll status
  console.log('Polling status (interval:', POLL_INTERVAL_MS, 'ms, timeout:', POLL_TIMEOUT_MS, 'ms)…')
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    const status = await sw.getSwidgeStatus(result.id)
    if (status.status !== last) {
      console.log(' ', new Date().toISOString(), 'status:', status.status)
      last = status.status
    }
    if (status.status === 'completed' || status.status === 'failed') {
      console.log('\nFinal status:', status.status)
      if (status.outTxHash) console.log('Out tx:', status.outTxHash)
      break
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (Date.now() >= deadline) {
    console.log('\n⚠ Timed out polling status — order ID:', result.id)
    console.log('Check manually via gateway-cli or the API.')
    process.exit(1)
  }
}

main().catch(function (err) {
  console.error('\nFatal error:', err.message || err)
  process.exit(2)
})

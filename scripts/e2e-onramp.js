/**
 * FUNDED e2e onramp script — BTC → USDT on Ethereum
 *
 * ⚠ THIS SCRIPT MOVES REAL FUNDS. ⚠
 * Run ONLY after the preflight harness passes.
 * Both guard env vars MUST be set:
 *   GATEWAY_E2E=1
 *   I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes
 *
 * Required env vars:
 *   BTC_SEED          — BIP-39 seed phrase for the BTC sender account
 *   EVM_ADDRESS       — destination EVM address for USDT
 *   AMOUNT_SATS       — satoshis to swap (default 1000000 = 0.01 BTC)
 *
 * Optional env vars:
 *   GATEWAY_API_URL   — override API URL
 *   GATEWAY_API_KEY   — override API key
 *   FEE_RATE          — sat/vByte fee rate (default: not set, wallet chooses)
 *   POLL_INTERVAL_MS  — polling interval (default 15000)
 *   POLL_TIMEOUT_MS   — max wait time (default 1800000 = 30 min)
 *
 * Usage:
 *   GATEWAY_E2E=1 I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes \
 *     BTC_SEED="word1 word2 …" EVM_ADDRESS=0x… \
 *     node scripts/e2e-onramp.js
 */

import { GatewaySwidge } from '../index.js'

// ─── guards ───────────────────────────────────────────────────────────────────

if (process.env.GATEWAY_E2E !== '1' || process.env.I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS !== 'yes') {
  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║          ⚠  FUNDED E2E SCRIPT — REAL FUNDS AT RISK  ⚠       ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')
  console.error('This script broadcasts a REAL BTC transaction on mainnet.')
  console.error('You must set BOTH of the following env vars to proceed:')
  console.error('')
  console.error('  GATEWAY_E2E=1')
  console.error('  I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes')
  console.error('')
  console.error('Run the preflight harness first: node scripts/preflight.js')
  process.exit(1)
}

if (!process.env.BTC_SEED) {
  console.error('BTC_SEED env var required (BIP-39 seed phrase for BTC sender account)')
  process.exit(1)
}

// ─── env ──────────────────────────────────────────────────────────────────────

const BTC_ZERO = '0x0000000000000000000000000000000000000000'
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

const GATEWAY_API_URL = process.env.GATEWAY_API_URL || undefined
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || undefined
const EVM_ADDRESS = process.env.EVM_ADDRESS || ''
const AMOUNT_SATS = BigInt(process.env.AMOUNT_SATS || '1000000')
const FEE_RATE = process.env.FEE_RATE ? Number(process.env.FEE_RATE) : undefined
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || '15000')
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || '1800000')

if (!EVM_ADDRESS) {
  console.error('EVM_ADDRESS env var required (recipient for USDT)')
  process.exit(1)
}

function sleep (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }

// ─── main ─────────────────────────────────────────────────────────────────────

async function main () {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║       BOB Gateway — FUNDED onramp: BTC → USDT-Ethereum      ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log('')
  console.log('Amount   :', AMOUNT_SATS.toString(), 'sats (', Number(AMOUNT_SATS) / 1e8, 'BTC )')
  console.log('Recipient:', EVM_ADDRESS)
  console.log('API URL  :', GATEWAY_API_URL || '(default mainnet)')
  console.log('')

  // Build BTC account from seed
  const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
  const btcWallet = new WalletManagerBtc(process.env.BTC_SEED, {
    client: { type: 'blockbook-http', clientConfig: { url: 'https://btc1.trezor.io/api' } },
    network: 'bitcoin'
  })
  const btcAccount = await btcWallet.getAccount(0)
  const btcAddress = await btcAccount.getAddress()
  console.log('BTC sender address:', btcAddress)

  // Build swidge config
  const cfg = { fromChain: 'bitcoin', feeRate: FEE_RATE }
  if (GATEWAY_API_URL) cfg.apiUrl = GATEWAY_API_URL
  if (GATEWAY_API_KEY) cfg.apiKey = GATEWAY_API_KEY

  const sw = new GatewaySwidge(btcAccount, cfg)

  // Get a preview quote before committing
  console.log('\nFetching preview quote…')
  const preview = await sw.quoteSwidge({
    fromToken: BTC_ZERO,
    toToken: USDT_ETH,
    toChain: 'ethereum',
    recipient: EVM_ADDRESS,
    fromTokenAmount: AMOUNT_SATS
  })
  console.log('  fromTokenAmount:', preview.fromTokenAmount.toString(), 'sats')
  console.log('  toTokenAmount  :', preview.toTokenAmount.toString(), 'USDT (6dp)')
  console.log('  fees           :', JSON.stringify(preview.fees.map(function (f) {
    return { type: f.type, amount: f.amount.toString() }
  })))
  console.log('')
  console.log('Proceeding to broadcast in 5 seconds — Ctrl+C to abort.')
  await sleep(5000)

  // Execute swidge
  console.log('\nBroadcasting BTC transaction…')
  const result = await sw.swidge({
    fromToken: BTC_ZERO,
    toToken: USDT_ETH,
    toChain: 'ethereum',
    recipient: EVM_ADDRESS,
    fromTokenAmount: AMOUNT_SATS
  })
  console.log('  order ID  :', result.id)
  console.log('  BTC tx    :', result.hash)
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

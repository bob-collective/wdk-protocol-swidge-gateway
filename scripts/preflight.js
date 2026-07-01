/**
 * pre-funds preflight harness
 *
 * Validates the swidge module against the real BOB Gateway V3 API
 * without moving any funds.
 *
 * Phases:
 *   A — live wire conformance (getSupportedChains / quoteSwidge)
 *   B — dry-run orders via GatewayClient (orphaned, no funds)
 *   C — WDK account wiring (getRequiredApproval, no broadcast) [only if seeds set]
 *
 * Env vars:
 *   GATEWAY_API_URL   — optional, defaults to mainnet
 *   GATEWAY_API_KEY   — optional, defaults to BOB attribution key
 *   BTC_ADDRESS       — required for quotes / Phase C comparison
 *   EVM_ADDRESS       — required for quotes / Phase C comparison
 *   BTC_SEED          — BIP-39 phrase for Phase C BTC account (optional)
 *   EVM_SEED          — BIP-39 phrase for Phase C EVM account (optional)
 *   AMOUNT_SATS       — sat amount for onramp quote (default 1000000)
 *   AMOUNT_USDT       — USDT amount for offramp quote (default 50000000)
 *
 * Usage:
 *   node scripts/preflight.js
 *   BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… node scripts/preflight.js
 */

import { GatewaySwidge, GatewayClient } from '../index.js'

// ─── constants ────────────────────────────────────────────────────────────────

const BTC_ZERO = '0x0000000000000000000000000000000000000000'
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const DEFAULT_SLIPPAGE = 0.03

// ─── env ──────────────────────────────────────────────────────────────────────

const GATEWAY_API_URL = process.env.GATEWAY_API_URL || undefined
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || undefined
const BTC_ADDRESS = process.env.BTC_ADDRESS || 'bc1qplaceholder000000000000000000000000000000'
const EVM_ADDRESS = process.env.EVM_ADDRESS || '0x0000000000000000000000000000000000000001'
const BTC_SEED = process.env.BTC_SEED || ''
const EVM_SEED = process.env.EVM_SEED || ''
const AMOUNT_SATS = BigInt(process.env.AMOUNT_SATS || '1000000')
const AMOUNT_USDT = BigInt(process.env.AMOUNT_USDT || '50000000')

// ─── helpers ──────────────────────────────────────────────────────────────────

let anyFailed = false

function pass (msg) {
  console.log('  ✓', msg)
}

function fail (msg, err) {
  anyFailed = true
  console.log('  ✗', msg)
  if (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.log('    └─', detail)
  }
}

function section (title) {
  console.log('\n' + title)
  console.log('─'.repeat(60))
}

function clientConfig () {
  const cfg = {}
  if (GATEWAY_API_URL) cfg.apiUrl = GATEWAY_API_URL
  if (GATEWAY_API_KEY) cfg.apiKey = GATEWAY_API_KEY
  return cfg
}

function swidgeConfig (fromChain) {
  return { fromChain, ...clientConfig() }
}

// ─── Phase A — live wire conformance ─────────────────────────────────────────

async function phaseA () {
  section('Phase A — live wire conformance (no orders, no funds)')

  // A1: getSupportedChains + getRoutes → assert BTC→USDT-Eth route exists
  try {
    const sw = new GatewaySwidge(null, swidgeConfig('bitcoin'))
    const chains = await sw.getSupportedChains()
    const chainIds = chains.map(function (c) { return c.id })
    console.log('    chains:', chainIds.join(', '))

    const client = new GatewayClient(clientConfig())
    const routes = await client.getRoutes()
    const btcToUsdt = routes.find(function (r) {
      return r.srcChain === 'bitcoin' &&
        r.dstChain === 'ethereum' &&
        r.srcToken === BTC_ZERO &&
        r.dstToken === USDT_ETH
    })
    if (!btcToUsdt) {
      fail('A1: BTC→USDT-Eth route NOT found in getRoutes()')
    } else {
      pass('A1: BTC→USDT-Eth route present in getRoutes()')
    }
    if (!chainIds.includes('bitcoin') || !chainIds.includes('ethereum')) {
      fail('A1: getSupportedChains() missing bitcoin or ethereum')
    } else {
      pass('A1: getSupportedChains() includes bitcoin and ethereum')
    }
  } catch (err) {
    fail('A1: getRoutes / getSupportedChains threw', err)
  }

  // A2: onramp quote — BTC → USDT-Eth
  try {
    const sw = new GatewaySwidge(null, swidgeConfig('bitcoin'))
    const q = await sw.quoteSwidge({
      fromToken: BTC_ZERO,
      toToken: USDT_ETH,
      toChain: 'ethereum',
      recipient: EVM_ADDRESS,
      fromTokenAmount: AMOUNT_SATS
    })
    if (!(q.toTokenAmount > 0n)) {
      fail('A2: onramp toTokenAmount not > 0', new Error('got: ' + q.toTokenAmount))
    } else {
      pass('A2: onramp quote')
      console.log('    fromTokenAmount:', q.fromTokenAmount.toString(), 'sats')
      console.log('    toTokenAmount  :', q.toTokenAmount.toString(), 'USDT (6dp)')
      console.log('    fees           :', JSON.stringify(q.fees.map(function (f) {
        return { type: f.type, amount: f.amount.toString() }
      })))
    }
  } catch (err) {
    fail('A2: onramp quoteSwidge threw', err)
  }

  // A3: offramp quote — USDT-Eth → BTC
  try {
    const sw = new GatewaySwidge(null, swidgeConfig('ethereum'))
    const q = await sw.quoteSwidge({
      fromToken: USDT_ETH,
      toToken: BTC_ZERO,
      toChain: 'bitcoin',
      recipient: BTC_ADDRESS,
      fromTokenAmount: AMOUNT_USDT
    })
    if (!(q.toTokenAmount > 0n)) {
      fail('A3: offramp toTokenAmount not > 0', new Error('got: ' + q.toTokenAmount))
    } else {
      pass('A3: offramp quote')
      console.log('    fromTokenAmount:', q.fromTokenAmount.toString(), 'USDT (6dp)')
      console.log('    toTokenAmount  :', q.toTokenAmount.toString(), 'sats')
      console.log('    fees           :', JSON.stringify(q.fees.map(function (f) {
        return { type: f.type, amount: f.amount.toString() }
      })))
    }
  } catch (err) {
    fail('A3: offramp quoteSwidge threw', err)
  }
}

// ─── Phase B — dry-run orders (orphaned, no funds moved) ─────────────────────

async function phaseB () {
  section('Phase B — dry-run orders via GatewayClient (orphaned, NO funds)')
  console.log('  NOTE: these create real order IDs that will be abandoned.')

  const client = new GatewayClient(clientConfig())
  const slippageBps = String(Math.round(DEFAULT_SLIPPAGE * 10000))

  // B1: onramp dry-run
  try {
    const params = {
      srcChain: 'bitcoin',
      dstChain: 'ethereum',
      srcToken: BTC_ZERO,
      dstToken: USDT_ETH,
      amount: String(AMOUNT_SATS),
      slippage: slippageBps,
      recipient: EVM_ADDRESS,
      ownerAddress: EVM_ADDRESS
    }
    const quote = await client.getQuote(params)
    const order = await client.createOrder({ onramp: quote.onramp })
    const onramp = order.onramp
    if (!onramp || !onramp.orderId) {
      fail('B1: onramp order missing orderId')
    } else {
      pass('B1: onramp dry-run order created (ORPHANED)')
      console.log('    orderId:', onramp.orderId)
      console.log('    deposit address:', onramp.address)
    }
  } catch (err) {
    fail('B1: onramp dry-run threw', err)
  }

  // B2: offramp dry-run
  try {
    const params = {
      srcChain: 'ethereum',
      dstChain: 'bitcoin',
      srcToken: USDT_ETH,
      dstToken: BTC_ZERO,
      amount: String(AMOUNT_USDT),
      slippage: slippageBps,
      recipient: BTC_ADDRESS,
      sender: EVM_ADDRESS,
      ownerAddress: EVM_ADDRESS
    }
    const quote = await client.getQuote(params)
    const order = await client.createOrder({ offramp: quote.offramp })
    const offramp = order.offramp
    if (!offramp || !offramp.orderId) {
      fail('B2: offramp order missing orderId')
    } else {
      pass('B2: offramp dry-run order created (ORPHANED)')
      console.log('    orderId:', offramp.orderId)
      console.log('    spender (tx.to):', offramp.tx && offramp.tx.to)
    }
  } catch (err) {
    fail('B2: offramp dry-run threw', err)
  }
}

// ─── Phase C — real WDK account wiring (no broadcast, no funds) ──────────────

async function phaseC () {
  section('Phase C — WDK account wiring (no broadcast, no funds)')

  if (!BTC_SEED && !EVM_SEED) {
    console.log('  ⚠ BTC_SEED and EVM_SEED not set — skipping Phase C')
    return
  }

  // C1: derive BTC address from seed
  let btcAccount = null
  if (BTC_SEED) {
    try {
      const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
      const wallet = new WalletManagerBtc(BTC_SEED, {
        client: { type: 'blockbook-http', clientConfig: { url: 'https://btc1.trezor.io/api' } },
        network: 'bitcoin'
      })
      btcAccount = await wallet.getAccount(0)
      const btcAddr = await btcAccount.getAddress()
      pass('C1: BTC account derived from seed')
      console.log('    BTC address:', btcAddr)
      if (process.env.BTC_ADDRESS && btcAddr !== BTC_ADDRESS) {
        console.log('    ⚠ does NOT match BTC_ADDRESS env:', BTC_ADDRESS)
      }
    } catch (err) {
      fail('C1: BTC account construction failed', err)
      console.log('  ⚠ Skipping BTC-dependent Phase C steps')
    }
  } else {
    console.log('  ⚠ BTC_SEED not set — skipping C1')
  }

  // C2: derive EVM address from seed
  let evmAccount = null
  if (EVM_SEED) {
    try {
      const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')
      const wallet = new WalletManagerEvm(EVM_SEED, {
        provider: 'https://eth.drpc.org'
      })
      evmAccount = await wallet.getAccount(0)
      const evmAddr = await evmAccount.getAddress()
      pass('C2: EVM account derived from seed')
      console.log('    EVM address:', evmAddr)
      if (process.env.EVM_ADDRESS && evmAddr.toLowerCase() !== EVM_ADDRESS.toLowerCase()) {
        console.log('    ⚠ does NOT match EVM_ADDRESS env:', EVM_ADDRESS)
      }
    } catch (err) {
      fail('C2: EVM account construction failed', err)
      console.log('  ⚠ Skipping EVM-dependent Phase C steps')
    }
  } else {
    console.log('  ⚠ EVM_SEED not set — skipping C2')
  }

  // C3: getRequiredApproval — reads real USDT allowance (no broadcast)
  if (evmAccount) {
    try {
      const sw = new GatewaySwidge(evmAccount, swidgeConfig('ethereum'))
      const approval = await sw.getRequiredApproval({
        fromToken: USDT_ETH,
        toToken: BTC_ZERO,
        toChain: 'bitcoin',
        recipient: BTC_ADDRESS,
        fromTokenAmount: AMOUNT_USDT
      })
      pass('C3: getRequiredApproval completed')
      if (approval === null) {
        console.log('    result: null (allowance already covers amount)')
      } else {
        console.log('    result:', JSON.stringify({
          token: approval.token,
          spender: approval.spender,
          amount: approval.amount.toString()
        }))
      }
    } catch (err) {
      fail('C3: getRequiredApproval threw', err)
    }
  } else {
    console.log('  ⚠ no EVM account — skipping C3')
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main () {
  console.log('BOB Gateway swidge — pre-funds preflight harness')
  console.log('API URL:', GATEWAY_API_URL || '(default mainnet)')
  console.log('BTC address:', BTC_ADDRESS)
  console.log('EVM address:', EVM_ADDRESS)
  console.log('Amount sats:', AMOUNT_SATS.toString())
  console.log('Amount USDT:', AMOUNT_USDT.toString(), '(6dp =', Number(AMOUNT_USDT) / 1e6, 'USDT)')

  await phaseA()
  await phaseB()
  await phaseC()

  section('Result')
  if (anyFailed) {
    console.log('  ✗ One or more checks FAILED — see above')
    process.exit(1)
  } else {
    console.log('  ✓ All checks passed')
    process.exit(0)
  }
}

main().catch(function (err) {
  console.error('Fatal error in preflight harness:', err)
  process.exit(2)
})

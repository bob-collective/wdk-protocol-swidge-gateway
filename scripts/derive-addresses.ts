/**
 * derive-addresses.ts
 *
 * Reads TEST_SEED from the environment, constructs BTC (BIP-84), EVM, and Tron
 * (BIP-44 m/44'/195') accounts at index 0, and prints the addresses to fund.
 *
 * Run locally via 1Password:
 *   op run --env-file=.env.op -- pnpm derive-addresses
 *
 * Never logs the seed — only the derived addresses.
 */

const seed = process.env.TEST_SEED
if (!seed) {
  console.error(
    'ERROR: TEST_SEED is not set. Provide it via op run --env-file=.env.op or export it manually.'
  )
  process.exit(1)
}

const evmRpc = process.env.EVM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'
const tronRpc = process.env.TRON_RPC_URL ?? 'https://tron.api.pocket.network'

// Dynamic imports so the WDK managers are only loaded when the seed is present.
const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')
const { default: WalletManagerTron } = await import('@tetherto/wdk-wallet-tron')

const btcWallet = new WalletManagerBtc(seed, { network: 'bitcoin' })
const btcAccount = await btcWallet.getAccount(0)
const btcAddress: string = await btcAccount.getAddress()

const evmWallet = new WalletManagerEvm(seed, { provider: evmRpc })
const evmAccount = await evmWallet.getAccount(0)
const evmAddress: string = await evmAccount.getAddress()

const tronWallet = new WalletManagerTron(seed, { provider: tronRpc })
const tronAccount = await tronWallet.getAccount(0)
const tronAddress: string = await tronAccount.getAddress()

console.log('BTC address (BIP-84 / bc1…):', btcAddress)
console.log('EVM address:', evmAddress)
console.log('Tron address (BIP-44 / T…):', tronAddress)
console.log()
console.log('Fund these addresses before running the integration suite:')
console.log('  BTC:  send at least 30 000 sats (~0.0003 BTC) — fits a $50 wallet with fee headroom')
console.log('  EVM:  send USDT (≥50 USDT) + a small ETH amount for gas estimation')
console.log('  Tron: send USDT-TRC20 (≥50 USDT) + ~30 TRX for energy/bandwidth (offramp only)')

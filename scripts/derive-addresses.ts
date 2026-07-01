/**
 * derive-addresses.ts
 *
 * Reads TEST_SEED from the environment, constructs a BTC (BIP-84) account and an
 * EVM account (account index 0 for both), and prints the two addresses to fund.
 *
 * Run locally via 1Password:
 *   op run --env-file=.env.op -- pnpm derive-addresses
 *
 * Never logs the seed — only the derived addresses.
 */

const seed = process.env.TEST_SEED
if (!seed) {
  console.error('ERROR: TEST_SEED is not set. Provide it via op run --env-file=.env.op or export it manually.')
  process.exit(1)
}

const evmRpc = process.env.EVM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'

// Dynamic imports so the WDK managers are only loaded when the seed is present.
const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')

const btcWallet = new WalletManagerBtc(seed, { network: 'bitcoin' })
const btcAccount = await btcWallet.getAccount(0)
const btcAddress: string = await btcAccount.getAddress()

const evmWallet = new WalletManagerEvm(seed, { provider: evmRpc })
const evmAccount = await evmWallet.getAccount(0)
const evmAddress: string = await evmAccount.getAddress()

console.log('BTC address (BIP-84 / bc1…):', btcAddress)
console.log('EVM address:', evmAddress)
console.log()
console.log('Fund both addresses before running the integration suite:')
console.log('  BTC: send at least 30 000 sats (~0.0003 BTC) — fits a $50 wallet with fee headroom')
console.log('  EVM: send USDT (≥50 USDT) + a small ETH amount for gas estimation')

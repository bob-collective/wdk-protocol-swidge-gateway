# @gobob/wdk-protocol-swidge-gateway

## 🔍 About WDK

The Wallet Development Kit (WDK) is a modular framework for building non-custodial wallets that work across Bitcoin, EVM chains, Tron, and more. Protocol modules like this one plug into a WDK account to add specific cross-chain capabilities without requiring private-key exposure.

## 🌟 Features

- **Native BTC ↔ EVM**: Bidirectional swidge between Bitcoin and any supported EVM chain.
- **BTC → Tron**: Send BTC and receive USDT (or other tokens) on Tron (destination only in v1; see [Tron-as-source tracking issue](https://github.com/tetherto/wdk-wallet-tron/issues/48)).
- **EVM ↔ EVM**: Same-chain swaps and cross-chain bridges via the inherited `swap()` / `bridge()` methods.
- **Affiliate fees**: Earn revenue on BTC ↔ EVM routes with configurable per-address basis-point fees.
- **Zero-config attribution**: The default `bearerToken` attributes gateway-wdk volume to BOB at 0 fee.
- **Non-custodial**: Keys never leave the WDK account. Signing is fully delegated.
- **Multi-runtime**: Works on Node.js, Bare (`bare.js`), and React Native out of the box.

## ⬇️ Installation

```bash
pnpm add @gobob/wdk-protocol-swidge-gateway
```

## 🚀 Quick Start

### Option 1 — With WDK Core (recommended)

```js
import WDK from '@tetherto/wdk-wallet'
import GatewaySwidge from '@gobob/wdk-protocol-swidge-gateway'

const account = await WDK.create({ ... })
const sw = new GatewaySwidge(account, { fromChain: 'bitcoin' })

const result = await sw.swidge({
  fromToken: 'BTC',
  toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
  toChain: 'base',
  recipient: '0xYourEVMAddress',
  fromTokenAmount: 100000n // satoshis
})
console.log('Order ID:', result.id, 'Tx hash:', result.hash)
```

### Option 2 — Direct instantiation

```js
import { GatewaySwidge, GatewayClient } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, {
  fromChain: 'base',
  slippage: 0.01
})
```

## Examples

### BTC → Token on EVM (onramp)

```js
// See examples/onramp-btc-to-usdt-base.js
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, { fromChain: 'bitcoin' })
const result = await sw.swidge({
  fromToken: 'BTC',
  toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
  toChain: 'base',
  recipient: '0xRecipient',
  fromTokenAmount: 100000n // satoshis
})
```

### Token on EVM → BTC (offramp)

Approve the token to the spender before calling `swidge()`:

```js
// See examples/offramp-usdt-to-btc.js
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, { fromChain: 'base' })
const options = {
  fromToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
  toToken: 'BTC',
  toChain: 'bitcoin',
  recipient: 'bc1qRecipientAddress',
  fromTokenAmount: 1000000n // USDT (6 decimals)
}

// Check and grant approval first
const approval = await sw.getRequiredApproval(options)
if (approval) {
  await account.approve(approval.token, approval.spender, approval.amount)
}

const result = await sw.swidge(options)
```

### EVM ↔ EVM (swap / bridge)

```js
// See examples/evm-swap.js — uses the inherited swap() method
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, { fromChain: 'base' })
const result = await sw.swap({
  tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // USDC on Base
  tokenOut: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT on Base
  tokenInAmount: 1000000n
})
```

### BTC → USDT on Tron (destination-only)

```js
// See examples/onramp-btc-to-usdt-tron.js
// Tron as SOURCE is not supported in v1 — track https://github.com/tetherto/wdk-wallet-tron/issues/48
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, { fromChain: 'bitcoin' })
const result = await sw.swidge({
  fromToken: 'BTC',
  toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
  toChain: 'tron',
  recipient: 'TRecipientAddress',
  fromTokenAmount: 100000n
})
```

### Affiliate Fees

```js
// See examples/affiliate-fees.js
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, {
  fromChain: 'bitcoin',
  affiliates: [{ address: '0xPartnerAddress', bps: 30 }] // 0.3%
})
const result = await sw.swidge({
  fromToken: 'BTC',
  toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  toChain: 'base',
  recipient: '0xRecipient',
  fromTokenAmount: 100000n
})
```

Affiliate limits: **≤ 5 entries, total ≤ 1000 bps (10%), each entry bps > 0, no zero or duplicate addresses**. EVM↔EVM routes do not support affiliate fees — they are dropped gracefully (`affiliateApplied: false` in the quote).

### Quote and Status

```js
// See examples/quote-and-status.js
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const sw = new GatewaySwidge(account, { fromChain: 'bitcoin' })

const quote = await sw.quoteSwidge({
  fromToken: 'BTC',
  toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  toChain: 'base',
  recipient: '0xRecipient',
  fromTokenAmount: 100000n
})
console.log('Expected output:', quote.toTokenAmount)

// After executing swidge(), poll for status:
const status = await sw.getSwidgeStatus('order-id')
console.log(status.status, status.transactions)
```

## 📚 API Reference

### Exports

```js
import { GatewaySwidge, GatewayClient, GatewaySwidgeError, ERR, BTC } from '@gobob/wdk-protocol-swidge-gateway'
// Default export:
import GatewaySwidge from '@gobob/wdk-protocol-swidge-gateway'
```

### `new GatewaySwidge(account, config?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `account` | `object` | WDK wallet account (BTC or EVM). |
| `config.apiUrl` | `string?` | Gateway API base URL. |
| `config.bearerToken` | `string?` | API Bearer token. Defaults to BOB's gateway-wdk attribution key (0 fee, attributes volume to BOB). |
| `config.http` | `object?` | Injectable HTTP transport (useful for testing). |
| `config.affiliates` | `Array<{address: string, bps: number}>?` | Affiliate fee entries. |
| `config.paymasterToken` | `string?` | ERC-20 paymaster token for AA accounts. |
| `config.slippage` | `number?` | Default slippage fraction (default `0.03` = 3%). |
| `config.feeRate` | `number?` | BTC fee rate in sat/vByte. |
| `config.fromChain` | `string?` | Source chain id. Required when not passed in `SwidgeOptions`. |

### `SwidgeOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromToken` | `string` | Yes | Source token: pass `'BTC'` (or the exported `BTC` constant) for Bitcoin — normalised internally to the gateway's native-token zero-address. ERC-20/TRC-20 tokens are passed as their contract address. |
| `toToken` | `string` | Yes | Destination token: pass `'BTC'` (or `BTC` constant) for Bitcoin, or a contract address for ERC-20/TRC-20 tokens. |
| `toChain` | `string` | Yes | Destination chain id (e.g. `'base'`, `'bitcoin'`, `'tron'`). |
| `recipient` | `string` | Yes | Recipient address on the destination chain. |
| `fromTokenAmount` | `bigint` | Yes | Amount to send (in the token's smallest unit). |
| `refundAddress` | `string?` | No | Address to receive a refund on the source chain if the order fails. |
| `slippage` | `number?` | No | Per-call slippage override (overrides `config.slippage`). |

### Methods

#### `quoteSwidge(options) → Promise<SwidgeQuote>`

Returns a quote without executing a transaction. Useful for displaying expected output and fees before commitment.

#### `swidge(options) → Promise<SwidgeResult>`

Executes a swidge. Returns:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Gateway order ID — pass to `getSwidgeStatus()`. |
| `hash` | `string` | Source-chain transaction hash or TXID. |
| `fees` | `object` | Fee breakdown from the quote. |
| `fromTokenAmount` | `bigint` | Actual input amount. |
| `toTokenAmount` | `bigint` | Expected output amount. |

For offramp and token-swap routes, call `getRequiredApproval()` and `approve()` on the account before calling `swidge()`.

#### `getSwidgeStatus(id) → Promise<{ status: string, transactions: object[] }>`

Polls order status by the `id` returned from `swidge()`.

#### `getSupportedChains() → Promise<SwidgeSupportedChain[]>`

Returns supported source/destination chains.

#### `getSupportedTokens(options?) → Promise<SwidgeSupportedToken[]>`

Returns supported tokens, optionally filtered by `options`.

#### `getRequiredApproval(options) → Promise<{ token: string, spender: string, amount: bigint } | null>`

Returns the ERC-20 approval the caller must grant before executing an offramp or token-swap swidge. Returns `null` for onramp routes (native asset, no approval needed).

**Important:** On a cache miss, this method creates a Gateway order internally to discover the spender contract address (the V3 API has no read-only spender lookup endpoint). Results are cached per route on the `GatewaySwidge` instance, so callers should not invoke `getRequiredApproval` before every swap — call it once per route and reuse the result.

#### Inherited methods

`swap(options)`, `bridge(options)`, `quoteSwap(options)`, `quoteBridge(options)` — inherited from `SwidgeProtocol` for EVM↔EVM routes.

## 🌐 Supported Networks & Routes

| Route | Direction | Notes |
|-------|-----------|-------|
| BTC ↔ EVM chains | Bidirectional | Supports affiliate fees |
| BTC → Tron | Destination only | Tron-as-source not in v1 ([tracking issue](https://github.com/tetherto/wdk-wallet-tron/issues/48)) |
| EVM ↔ EVM | Bidirectional | Use `swap()` / `bridge()` (inherited). Affiliate fees not supported on this route. |
| Solana | Coming soon | Not available in v1 |

## Known Limitations & Integration Notes

- **USDT (Ethereum) approval reset:** Before an offramp of USDT-on-Ethereum, the WDK account's `approve()` throws if a non-zero allowance is already set — USDT's non-standard `approve` reverts when changing from a non-zero value. You must send `approve({ token, spender, amount: 0n })` first to reset to zero, then approve the real amount. (The underlying transaction itself is a plain ERC-20 call, so WDK's signing path is fine.)

- **Approval pre-flight (`getRequiredApproval`) is a simple allowance check:** It returns an approval whenever `allowance < amount`. Some OFT-style receiver contracts do not require an ERC-20 approval at all; for those, approving anyway is harmless (the gateway contract ignores the allowance). The `@gobob/bob-sdk` additionally probes the receiver's `approvalRequired()` method; this module does not — it relies on the gateway to route the transaction correctly.

- **Offramp tx is registered on broadcast, not after mining:** WDK's `sendTransaction` returns once the tx is broadcast; the module registers the resulting `srcTxHash` immediately. The gateway watches the chain for the registered hash, so no confirmation wait is required — this is expected behaviour, not a race condition.

- **Gas:** The module relies on the WDK account's built-in gas estimation with no extra buffer. If an offramp contract call ever reverts out-of-gas, pass a gas override via the account's send options or raise an issue.

## 🔒 Security Considerations

- **Keys never leave the WDK account.** All signing is delegated to the account abstraction layer — `GatewaySwidge` never has direct key access.
- **No external wallet dependencies.** This package does not depend on `viem`, `@gobob/bob-sdk`, or any other wallet library.
- **Approval hygiene.** For offramp/tokenSwap routes, call `getRequiredApproval()` first and approve only the exact required amount. Do not pre-approve unlimited amounts.
- **BOB attribution key.** The default `bearerToken` is a shared gateway-wdk attribution token that attributes volume to BOB at 0 cost. Replace it with your own key only if you have a direct API agreement.

## 🛠️ Development

```bash
pnpm install
pnpm run lint
pnpm run test
pnpm run build:types
```

### Test accounts (local development)

The shared mainnet test accounts used by the CI validation and swap lanes are derived from the `op://WDK Gateway/seed/mnemonic` 1Password item (BIP-84 for BTC, BIP-44 for EVM, account index 0). Their public addresses:

| Chain | Address |
|-------|---------|
| BTC (BIP-84) | `bc1q4qzrf00t40tnqlc374s07dnnywltz0pt2aqmya` |
| EVM (BIP-44) | `0xea9A10783EBbb42Bfc0e8fb13b5210A57276d560` |

Fund these to run the live integration suite (`op run --env-file=.env.op -- pnpm exec vitest run tests/integration`) or the swap harness. See [docs/testing.md](./docs/testing.md) for the full setup.

## 📜 License

Apache-2.0. See [LICENSE](./LICENSE).

## 🤝 Contributing

Pull requests welcome. Please open an issue first to discuss significant changes.

## 🆘 Support

- [GitHub Issues](https://github.com/tetherto/wdk-wallet/issues)
- [BOB Discord](https://discord.gg/gobob)

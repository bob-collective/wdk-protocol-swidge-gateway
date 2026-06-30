# API Reference — @gobob/wdk-protocol-swidge-gateway

## Exports

```js
import { GatewaySwidge, GatewayClient, GatewaySwidgeError, ERR } from '@gobob/wdk-protocol-swidge-gateway'
// Default export:
import GatewaySwidge from '@gobob/wdk-protocol-swidge-gateway'
```

## `GatewaySwidge`

Main class. Extends `SwidgeProtocol` from `@tetherto/wdk-wallet`.

### Constructor

```js
new GatewaySwidge(account, config?)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `account` | `object` | — | WDK wallet account (BTC or EVM). |
| `config.apiUrl` | `string` | BOB Gateway V3 | Gateway API base URL. |
| `config.apiKey` | `string` | BOB attribution key | API Bearer token. Defaults to BOB's gateway-wdk attribution key (0 fee). |
| `config.http` | `object` | — | Injectable HTTP transport (for tests). |
| `config.affiliates` | `Array<{address: string, bps: number}>` | — | Affiliate fee entries. |
| `config.paymasterToken` | `string` | — | ERC-20 paymaster token for AA accounts. |
| `config.slippage` | `number` | `0.03` | Default slippage fraction (3%). |
| `config.feeRate` | `number` | — | BTC fee rate in sat/vByte. |
| `config.fromChain` | `string` | — | Source chain id. Required when not passed in `SwidgeOptions`. |

### `SwidgeOptions`

Passed to `quoteSwidge()`, `swidge()`, and `getRequiredApproval()`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromToken` | `string` | Yes | Source token: `'BTC'` or an ERC-20/TRC-20 contract address. |
| `toToken` | `string` | Yes | Destination token: `'BTC'` or a contract address. |
| `toChain` | `string` | Yes | Destination chain id (e.g. `'base'`, `'bitcoin'`, `'tron'`). |
| `recipient` | `string` | Yes | Recipient address on the destination chain. |
| `fromTokenAmount` | `bigint` | Yes | Amount to send in the token's smallest unit (satoshis for BTC). |
| `refundAddress` | `string` | No | Refund address on the source chain if the order fails. |
| `slippage` | `number` | No | Per-call slippage override. Overrides `config.slippage`. |

### Methods

#### `quoteSwidge(options: SwidgeOptions) → Promise<SwidgeQuote>`

Returns a quote without submitting any transaction. Use to show expected output and fees before asking the user to confirm.

#### `swidge(options: SwidgeOptions) → Promise<SwidgeResult>`

Executes a swidge. Internally: fetches a quote, creates an order, sends the source transaction, and registers the hash with the gateway.

**Returns `SwidgeResult`:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Gateway order ID. Pass to `getSwidgeStatus()`. |
| `hash` | `string` | Source-chain transaction hash (EVM) or TXID (BTC). |
| `fees` | `object` | Fee breakdown from the quote. |
| `fromTokenAmount` | `bigint` | Actual input amount. |
| `toTokenAmount` | `bigint` | Expected output amount at quoted rate. |

> For offramp and token-swap routes (any route where an ERC-20 is the source), call `getRequiredApproval()` and approve the token before calling `swidge()`.

#### `getSwidgeStatus(id: string) → Promise<{ status: string, transactions: object[] }>`

Returns the current status of an order by the `id` from `SwidgeResult`.

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Order lifecycle status. |
| `transactions` | `object[]` | On-chain transactions associated with this order. |

#### `getSupportedChains() → Promise<SwidgeSupportedChain[]>`

Returns all supported source and destination chains.

#### `getSupportedTokens(options?) → Promise<SwidgeSupportedToken[]>`

Returns supported tokens. Pass `options` to filter by chain or other criteria.

#### `getRequiredApproval(options: SwidgeOptions) → Promise<{ token: string, spender: string, amount: bigint } | null>`

Computes the ERC-20 approval that must be granted before calling `swidge()` for offramp or token-swap routes. Returns `null` for onramp routes (BTC source — no ERC-20 approval needed).

| Return field | Type | Description |
|-------------|------|-------------|
| `token` | `string` | ERC-20 token address to approve. |
| `spender` | `string` | Spender address (gateway contract). |
| `amount` | `bigint` | Exact amount to approve. |

#### Inherited methods (EVM ↔ EVM)

| Method | Description |
|--------|-------------|
| `swap(options)` | Same-chain EVM token swap. |
| `bridge(options)` | Cross-chain EVM bridge. |
| `quoteSwap(options)` | Quote a same-chain swap. |
| `quoteBridge(options)` | Quote a cross-chain bridge. |

Affiliate fees are **not** applied on EVM↔EVM routes (dropped gracefully; `affiliateApplied: false` in the quote).

## `GatewayClient`

Low-level HTTP client for the BOB Gateway V3 API. Instantiated automatically by `GatewaySwidge`. Expose it only when you need raw API access.

## `GatewaySwidgeError` / `ERR`

Typed error class and error-code constants for programmatic error handling.

```js
import { GatewaySwidgeError, ERR } from '@gobob/wdk-protocol-swidge-gateway'

try {
  await sw.swidge(options)
} catch (err) {
  if (err instanceof GatewaySwidgeError) {
    console.error(err.code, err.message) // e.g. ERR.INSUFFICIENT_LIQUIDITY
  }
}
```

## Affiliate Fee Configuration

```js
const sw = new GatewaySwidge(account, {
  fromChain: 'bitcoin',
  affiliates: [
    { address: '0xPartner1', bps: 30 }, // 0.30%
    { address: '0xPartner2', bps: 20 }  // 0.20%
  ]
})
```

Constraints:

- At most **5 entries**.
- Total bps across all entries **≤ 1000** (10%).
- Each `bps` must be **> 0**.
- No zero address (`0x000...`) or duplicate addresses.
- EVM↔EVM routes: affiliates are ignored and `affiliateApplied` will be `false` in the returned quote.

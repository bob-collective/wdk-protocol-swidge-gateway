# API Reference — @gobob/wdk-protocol-swidge-gateway

## Exports

```js
import {
  GatewaySwidge,
  GatewayClient,
  GatewaySwidgeError,
  ERR,
  BTC,
  buildTronApproval,
} from '@gobob/wdk-protocol-swidge-gateway'
// Default export:
import GatewaySwidge from '@gobob/wdk-protocol-swidge-gateway'
```

`BTC` — exported string constant `'BTC'`. Use it as `fromToken` or `toToken` for Bitcoin routes. Normalised internally to the gateway's native-token zero-address (`0x000...0`); ERC-20/TRC-20 tokens are passed as their contract address.

## `GatewaySwidge`

Main class. Extends `SwidgeProtocol` from `@tetherto/wdk-wallet`.

### Constructor

```js
new GatewaySwidge(account, config?)
```

| Parameter               | Type                                    | Default             | Description                                                                                        |
| ----------------------- | --------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `account`               | `object`                                | —                   | WDK wallet account (BTC, EVM or Tron).                                                             |
| `config.apiUrl`         | `string`                                | BOB Gateway mainnet | Gateway API base URL.                                                                              |
| `config.bearerToken`    | `string`                                | BOB attribution key | API Bearer token. Defaults to BOB's gateway-wdk attribution key (0 fee).                           |
| `config.http`           | `object`                                | —                   | Injectable HTTP transport (for tests).                                                             |
| `config.affiliates`     | `Array<{address: string, bps: number}>` | —                   | Affiliate fee entries.                                                                             |
| `config.paymasterToken` | `string`                                | —                   | ERC-20 paymaster token for AA accounts.                                                            |
| `config.slippage`       | `number`                                | gateway-resolved    | Default slippage fraction (e.g. `0.01` = 1%). Unset: omitted; the gateway picks one per route.     |
| `config.feeRate`        | `number`                                | —                   | BTC fee rate in sat/vByte.                                                                         |
| `config.fromChain`      | `string`                                | —                   | Source chain id. Required when not passed in `SwidgeOptions`.                                      |
| `config.refundAddress`  | `string`                                | account address     | Refund target, encoded for the **source** chain (see below).                                       |
| `config.tronWeb`        | `object`                                | account's provider  | Tron source routes only. tronweb instance used to build the order call and read TRC-20 allowances. |
| `config.tronProvider`   | `string`                                | —                   | Tron source routes only. Full-node URL to build a tronweb client from.                             |
| `config.tronConfirmTimeoutMs` | `number`                          | `20000`             | Tron source routes only. How long a broadcast Tron transaction is given to appear on the node; finite and `>= 0`. |

Gateway V4 requires a `refundAddress` on every route before it creates an order — create-order answers `MISSING_REFUND_ADDRESS` otherwise — and it is encoded for the **source** chain: a Bitcoin address on an onramp, the EVM `0x…` or Tron Base58Check sender on an offramp or token swap. Precedence is `options.refundAddress` → `config.refundAddress` → the account's own address (the wallet the funds leave from). It goes on the wire as-is; unlike V3's EVM-only `ownerAddress` (removed in V4), a Tron address is not converted. `swidge()`, `simulateSwidge()` and `getRequiredApproval()` refuse to create an order when none can be resolved.

Both Tron options only select the node that **builds** the order call and reads allowances. Broadcasting always goes through the account, so a `WalletAccountTron` must be connected to a provider of its own regardless — neither option substitutes for that.

Pass a real tronweb instance to `config.tronWeb`. The module relies on tronweb re-deriving the response's `raw_data_hex`/`txID` from the locally requested call; on top of that it re-checks the built transaction itself (contract type, owner, target, calldata, call value, fee limit, hash binding and expiration window) before the account signs it. It also requires the hash the account reports back to equal the signed transaction's own `txID` (case and any `0x` prefix aside), so a node answering with a different existing txid cannot get that hash returned, and then reads that txID back through `trx.getTransaction` — a Tron node echoes the txID in its **rejection** body too, and `WalletAccountTron.sendTransaction` returns that hash without reading the status, so the hash alone does not mean the transaction was accepted. The read-back counts only when the node answers with the transaction itself, carrying a matching `txID`: an empty body, or one describing some other txid, is treated as still-unknown and retried until the timeout — `trx.getTransaction` is structurally typed, so nothing makes a caller's provider raise on not-found the way tronweb's own does. And because the account broadcasts through its own provider, the read-back goes through that provider too, falling back to `config.tronWeb`/`config.tronProvider` only when the account carries none: polling the build node for a transaction it never saw would fail a broadcast the broadcasting node had accepted. A provider without `trx.getTransaction` is refused before anything is signed, as is a `config.tronConfirmTimeoutMs` that is not a finite, non-negative number of milliseconds — `NaN` or `Infinity` would make a deadline that never passes.

### `SwidgeOptions`

Passed to `quoteSwidge()`, `swidge()`, and `getRequiredApproval()`.

| Field             | Type     | Required | Description                                                                                                                                                                                            |
| ----------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fromToken`       | `string` | Yes      | Source token: pass `'BTC'` (or the exported `BTC` constant) for Bitcoin — normalised internally to the gateway's native-token zero-address. ERC-20/TRC-20 tokens are passed as their contract address. |
| `toToken`         | `string` | Yes      | Destination token: pass `'BTC'` (or `BTC` constant) for Bitcoin, or a contract address for ERC-20/TRC-20 tokens.                                                                                       |
| `toChain`         | `string` | Yes      | Destination chain id (e.g. `'base'`, `'bitcoin'`, `'tron'`).                                                                                                                                           |
| `recipient`       | `string` | Yes      | Recipient address on the destination chain.                                                                                                                                                            |
| `fromTokenAmount` | `bigint` | Yes      | Amount to send in the token's smallest unit (satoshis for BTC).                                                                                                                                        |
| `refundAddress`   | `string` | No       | Source-chain refund address. Overrides `config.refundAddress` and the account-address default.                                                                                                         |
| `slippage`        | `number` | No       | Per-call slippage override. Overrides `config.slippage`. Unset on both: the gateway resolves it per route.                                                                                             |

### Methods

#### `quoteSwidge(options: SwidgeOptions) → Promise<SwidgeQuote>`

Returns a quote without submitting any transaction. Use to show expected output and fees before asking the user to confirm.

#### `swidge(options: SwidgeOptions) → Promise<SwidgeResult>`

Executes a swidge. Internally: fetches a quote, creates an order, then either hands the signed BTC transaction to the gateway's register-tx for broadcast (onramp — a register-tx failure throws; check the chain before resending, the tx may still have gone out) or broadcasts the EVM/Tron source transaction from the account (offramp/token swap — the gateway indexes it from chain; V4 has no register-tx for these).

**Returns `SwidgeResult`:**

| Field             | Type     | Description                                                           |
| ----------------- | -------- | --------------------------------------------------------------------- |
| `id`              | `string` | Gateway order ID. Pass to `getSwidgeStatus()`.                        |
| `hash`            | `string` | Source-chain transaction hash (EVM), bare txid (Tron), or TXID (BTC). |
| `fees`            | `object` | Fee breakdown from the quote.                                         |
| `fromTokenAmount` | `bigint` | Actual input amount.                                                  |
| `toTokenAmount`   | `bigint` | Expected output amount at quoted rate.                                |

> For offramp and token-swap routes (any route where an ERC-20 or TRC-20 is the source), call `getRequiredApproval()` and approve the token before calling `swidge()`.

#### `getSwidgeStatus(id: string) → Promise<{ status: string, transactions: object[] }>`

Returns the current status of an order by the `id` from `SwidgeResult`.

| Field          | Type       | Description                                       |
| -------------- | ---------- | ------------------------------------------------- |
| `status`       | `string`   | Order lifecycle status.                           |
| `transactions` | `object[]` | On-chain transactions associated with this order. |

#### `getSupportedChains() → Promise<SwidgeSupportedChain[]>`

Returns all supported source and destination chains.

#### `getSupportedTokens(options?) → Promise<SwidgeSupportedToken[]>`

Returns supported tokens. Pass `options` to filter by chain or other criteria.

#### `getRequiredApproval(options: SwidgeOptions) → Promise<{ token: string, spender: string, amount: bigint } | null>`

Computes the ERC-20/TRC-20 approval that must be granted before calling `swidge()` for offramp or token-swap routes. Returns `null` for onramp routes (BTC source — no token approval needed) and when the current allowance already covers `fromTokenAmount`.

The approval is **unbounded** (`amount` is `2^256 - 1`), as Gateway V4 and `@gobob/bob-sdk` grant it, so one approval covers later orders on the same route. Because an unbounded allowance puts the whole token balance behind the spender, the spender is checked against a hardcoded table of the Gateway's AllowanceHolder contracts per source chain (0x's canonical `0x0000000000001fF3684f28c67538d4D072C22734` on most EVM chains, Gateway's own on BOB and Tron) — never trusted from the create-order response. An unknown chain or a mismatched spender throws `VALIDATION_ERROR` instead of returning an approval; `simulateSwidge()` applies the same check to the approval it reports.

| Return field | Type     | Description                             |
| ------------ | -------- | --------------------------------------- |
| `token`      | `string` | ERC-20/TRC-20 token address to approve. |
| `spender`    | `string` | Gateway AllowanceHolder for the source chain. |
| `amount`     | `bigint` | `2^256 - 1` — unbounded approval.       |

On Tron the allowance is read with a constant-contract call through the resolved provider (`WalletAccountTron` has no allowance getter).

### Helpers

#### `buildTronApproval(approval, options?) → TronApprovalCall`

Turns a `getRequiredApproval()` result into a `TronSmartContractCall` that `WalletAccountTron.sendTransaction()` accepts. Needed because `WalletAccountTron` has no `approve()` method — its `transfer()` is a fixed `transfer(address,uint256)`.

| Parameter          | Type                                                 | Description                                                                             |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `approval`         | `{ token: string, spender: string, amount: bigint }` | The approval returned by `getRequiredApproval()`.                                       |
| `options.feeLimit` | `number?`                                            | Max sun to burn on the approve call (default 100 TRX). Must be a positive safe integer. |

#### `simulateSwidge()` on Tron

`tron.valid` means the full node accepted and pre-executed the contract call while building it — not that the fee or the account's resources were checked. Unlike the EVM leg, an account without `quoteSendTransaction` is not an error here: the build itself is the execution check, so `valid` is still meaningful and the missing fee is reported as `feeEstimate: null`.

#### Inherited methods (EVM ↔ EVM)

| Method                 | Description                 |
| ---------------------- | --------------------------- |
| `swap(options)`        | Same-chain EVM token swap.  |
| `bridge(options)`      | Cross-chain EVM bridge.     |
| `quoteSwap(options)`   | Quote a same-chain swap.    |
| `quoteBridge(options)` | Quote a cross-chain bridge. |

Affiliate fees are **not** applied on EVM↔EVM routes (dropped gracefully; `affiliateApplied: false` in the quote).

## `GatewayClient`

Low-level HTTP client for the BOB Gateway V4 API. Instantiated automatically by `GatewaySwidge`. Expose it only when you need raw API access.

## `GatewaySwidgeError` / `ERR`

Typed error class and error-code constants for programmatic error handling.

```js
import { GatewaySwidgeError, ERR } from '@gobob/wdk-protocol-swidge-gateway'

try {
  await sw.swidge(options)
} catch (err) {
  if (err instanceof GatewaySwidgeError) {
    // err.code is one of the ERR constants below
    console.error(err.code, err.message) // e.g. ERR.HTTP, ERR.UNSUPPORTED_ROUTE
  }
}
```

**Error codes (`ERR`):** `HTTP` (`'GATEWAY_HTTP_ERROR'`), `VALIDATION` (`'VALIDATION_ERROR'`), `UNSUPPORTED_ROUTE`, `NOT_SUPPORTED`, `APPROVAL_REQUIRED`.

## Affiliate Fee Configuration

```js
const sw = new GatewaySwidge(account, {
  fromChain: 'bitcoin',
  affiliates: [
    { address: '0xPartner1', bps: 30 }, // 0.30%
    { address: '0xPartner2', bps: 20 }, // 0.20%
  ],
})
```

Constraints:

- At most **5 entries**.
- Total bps across all entries **≤ 1000** (10%).
- Each `bps` must be **> 0**.
- No zero address (`0x000...`) or duplicate addresses.
- EVM↔EVM routes: affiliates are ignored and `affiliateApplied` will be `false` in the returned quote.

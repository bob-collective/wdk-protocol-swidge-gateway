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
| `config.maxNetworkFeeBps`  | `number \| bigint`                    | unchecked           | Refuse a `swidge()` whose network fees exceed this many bps of the input amount (see [Fee caps](#fee-caps)). |
| `config.maxProtocolFeeBps` | `number \| bigint`                    | unchecked           | Same, for the Gateway protocol fee.                                                                |
| `config.maxNativeFee`  | `bigint \| number \| string`           | per-chain (~$10–20) | Cap on native `value` the order tx may send beyond the swapped amount — the LayerZero/CCIP messaging fee on ERC-20 token swaps — in wei (sun on Tron). Overridable per call: `swidge(options, { maxNativeFee })`, and likewise as the second argument of `simulateSwidge()` and `getRequiredApproval()` — pass the same value to all three, or a preview or approval check can refuse an order `swidge()` would sign. |

Gateway V4 requires a `refundAddress` on every route before it creates an order — create-order answers `MISSING_REFUND_ADDRESS` otherwise — and it is encoded for the **source** chain: a Bitcoin address on an onramp, the EVM `0x…` or Tron Base58Check sender on an offramp or token swap. Precedence is `options.refundAddress` → `config.refundAddress` → the account's own address (the wallet the funds leave from). It goes on the wire as-is; unlike V3's EVM-only `ownerAddress` (removed in V4), a Tron address is not converted. `swidge()`, `simulateSwidge()` and `getRequiredApproval()` refuse to create an order when none can be resolved.

Both Tron options only select the node that **builds** the order call and reads allowances. Broadcasting always goes through the account, so a `WalletAccountTron` must be connected to a provider of its own regardless — neither option substitutes for that.

Pass a real tronweb instance to `config.tronWeb`. The module relies on tronweb re-deriving the response's `raw_data_hex`/`txID` from the locally requested call; on top of that it re-checks the built transaction itself (contract type, owner, target, calldata, call value, fee limit, hash binding and expiration window) before the account signs it. It also requires the hash the account reports back to equal the signed transaction's own `txID` (case and any `0x` prefix aside), so a node answering with a different existing txid cannot get that hash returned, and then reads that txID back through `trx.getTransaction` — a Tron node echoes the txID in its **rejection** body too, and `WalletAccountTron.sendTransaction` returns that hash without reading the status, so the hash alone does not mean the transaction was accepted. The read-back counts only when the node answers with the transaction itself, carrying a matching `txID`: an empty body, or one describing some other txid, is treated as still-unknown and retried until the timeout — `trx.getTransaction` is structurally typed, so nothing makes a caller's provider raise on not-found the way tronweb's own does. And because the account broadcasts through its own provider, the read-back goes through that provider too, falling back to `config.tronWeb`/`config.tronProvider` only when the account carries none: polling the build node for a transaction it never saw would fail a broadcast the broadcasting node had accepted. A provider without `trx.getTransaction` is refused before anything is signed, as is a `config.tronConfirmTimeoutMs` that is not a finite, non-negative number of milliseconds — `NaN` or `Infinity` would make a deadline that never passes.

### `SwidgeOptions`

Passed to `quoteSwidge()`, `swidge()`, and `getRequiredApproval()`.

| Field             | Type     | Required | Description                                                                                                                                                                                            |
| ----------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fromToken`       | `string` | Yes      | Source token: pass `'BTC'` (or the exported `BTC` constant) for Bitcoin — normalised internally to the gateway's native-token zero-address. ERC-20/TRC-20 tokens are passed as their contract address. |
| `toToken`         | `string` | Yes      | Destination token: pass `'BTC'` (or `BTC` constant) for Bitcoin — with `toChain: 'bitcoin'` (`ValueError` otherwise) — or a contract address for ERC-20/TRC-20 tokens.                             |
| `toChain`         | `string` | No       | Destination chain id (e.g. `'base'`, `'bitcoin'`, `'tron'`). Defaults to the source chain (a same-chain swap).                                                                                         |
| `recipient`       | `string` | Cross-chain | Recipient address on the destination chain. A same-chain swap defaults it to the account's address; a cross-chain route without one throws `ValueError` before quoting.                             |
| `fromTokenAmount` | `bigint` | Yes      | Amount to send in the token's smallest unit (satoshis for BTC). Exact-out (`toTokenAmount`) is not supported and throws `ValueError`.                                                                  |
| `minAmountOut`    | `bigint` | No       | Floor on the destination amount, in base units. `swidge()`/`simulateSwidge()` throw `SwidgeError` (`reason: COULD_NOT_MET_THRESHOLD`) before creating an order when the quote's `toTokenAmountMin` is below it. |
| `refundAddress`   | `string` | No       | Source-chain refund address. Overrides `config.refundAddress` and the account-address default.                                                                                                         |
| `slippage`        | `number` | No       | Per-call slippage override. Overrides `config.slippage`. Unset on both: the gateway resolves it per route.                                                                                             |

### Methods

#### `quoteSwidge(options: SwidgeOptions) → Promise<GatewaySwidgeQuote>`

Returns a quote without submitting any transaction. Use to show expected output and fees before asking the user to confirm. A WDK `SwidgeQuote` plus `affiliateApplied`:

| Field               | Type          | Description                                                                                                         |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `fromTokenAmount`   | `bigint`      | Input amount.                                                                                                       |
| `toTokenAmount`     | `bigint`      | Estimated output, net of fees.                                                                                      |
| `toTokenAmountMin`  | `bigint`      | `toTokenAmount × (1 − slippage)`, using the slippage the gateway echoes in the quote.                               |
| `fees`              | `SwidgeFee[]` | One entry per non-zero fee, each in **its own token** (`token`, `chain`) — see below. All have `included: true`.    |
| `estimatedDuration` | `number?`     | Seconds.                                                                                                            |
| `priceImpact`       | `number?`     | Fraction, as the gateway reports it: negative is a loss (`-0.0045` = 0.45%). Absent without a price feed.           |
| `affiliateApplied`  | `boolean`     | Whether the configured affiliates were sent (false on token swaps).                                                 |

Fees are never summed across entries, because they are not denominated in one token: an offramp's solver fee is USDT on Ethereum while its inclusion fee is BTC sats, and an onramp's fees are in USDT whatever the input. `type` is `network` (solver, Bitcoin inclusion, destination execution, LayerZero), `protocol` or `affiliate`. Token swaps report no fee breakdown — their costs are priced into `toTokenAmount`.

#### `swidge(options: SwidgeOptions, config?) → Promise<SwidgeResult>`

Executes a swidge. Internally: fetches a quote, creates an order, then either hands the signed BTC transaction to the gateway's register-tx for broadcast (onramp — a register-tx failure throws; check the chain before resending, the tx may still have gone out) or broadcasts the EVM/Tron source transaction from the account (offramp/token swap — the gateway indexes it from chain; V4 has no register-tx for these).

`config` takes per-call `maxNetworkFeeBps` / `maxProtocolFeeBps` (overriding the constructor's) and `paymasterToken`.

Before any gateway call, `swidge()` throws `AccountRequiredError` unless the account can sign on the source chain (`signTransaction` for Bitcoin, `sendTransaction` for EVM/Tron) — a read-only account can quote, not execute. Between quote and create-order it checks that the quote is the one asked for — exactly the route's variant, the requested input amount, and (where echoed) the recipient, refund address and token pair, else `GatewaySwidgeError` `VALIDATION_ERROR` — then `minAmountOut` and the fee caps, so a refused swidge leaves no orphaned order. The binding matters because create-order posts the quote verbatim and an onramp sends the quote's `inputAmount` of BTC; the other checks only compare the quote with itself.

**Returns `SwidgeResult`:**

| Field              | Type                  | Description                                                           |
| ------------------ | --------------------- | --------------------------------------------------------------------- |
| `id`               | `string`              | Gateway order ID. Pass to `getSwidgeStatus()`.                        |
| `hash`             | `string`              | Source-chain transaction hash (EVM), bare txid (Tron), or TXID (BTC). |
| `fees`             | `SwidgeFee[]`         | Fee lines from the quote (see `quoteSwidge()`).                       |
| `transactions`     | `SwidgeTransaction[]` | The source transaction: `{ hash, chain, type: 'source' }`.            |
| `fromTokenAmount`  | `bigint`              | Actual input amount.                                                  |
| `toTokenAmount`    | `bigint`              | Expected output amount at quoted rate.                                |
| `toTokenAmountMin` | `bigint`              | Minimum output after slippage.                                        |

##### Fee caps

`maxNetworkFeeBps` and `maxProtocolFeeBps` are basis points of the input amount. Since fees come in other tokens than the input, they are compared by the USD values the gateway attaches to each amount: `Σ fee.usd / input.usd × 10000`, in fixed-point. The gateway rounds each `usd` to the cent (a sub-cent fee reads `'0'`), so each fee line counts at `+$0.005` and the input at `−$0.005` — rounding can only make the check stricter, by up to half a cent per line. Exceeding a cap throws `MaximumFeeExceededError`. The check fails closed — with a cap set, an onramp/offramp quote without a fee breakdown, or one missing the USD value of the input or of a non-zero fee the cap covers, is refused (also `MaximumFeeExceededError`) rather than let through unchecked, and a fee under a breakdown key this module doesn't recognise is reported as `type: 'other'` and counted against both caps. A cap that isn't a finite, non-negative number throws `ValueError`. Affiliate fees are not capped. Unset caps are not checked. `simulateSwidge(options, config?)` applies the same caps.

Token-swap quotes carry no fee breakdown (costs are priced into `toTokenAmount`), so the caps have nothing to check there; bound a token swap with `minAmountOut` or `slippage` instead. `minAmountOut` itself is refused (`GatewaySwidgeError` `VALIDATION_ERROR`) when the quote doesn't echo its slippage, since `toTokenAmountMin` would then be the bare estimate rather than a floor.

> For offramp and token-swap routes (any route where an ERC-20 or TRC-20 is the source), call `getRequiredApproval()` and approve the token before calling `swidge()`.

#### `getSwidgeStatus(id: string) → Promise<SwidgeStatusResult>`

Returns the current status of an order by the `id` from `SwidgeResult`.

| Field          | Type                  | Description                                                                                                                                                  |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`       | `string`              | `pending`, `completed`, `failed`, `refund-pending` or `refunded`.                                                                                             |
| `transactions` | `SwidgeTransaction[]` | Every hash the order exposes, as `{ hash, chain, type }`: the `source` tx once indexed, `destination` payouts once completed, `refund` txs once refunded.   |

#### `getSupportedChains() → Promise<SwidgeSupportedChain[]>`

Returns all supported source and destination chains, with a display `name`, VM `type` (`utxo`, `evm`, `tvm`, `svm`) and `nativeToken` symbol from a built-in chain table. A chain the table doesn't know yet gets its raw id as name and an empty `nativeToken`.

#### `getSupportedTokens(options?) → Promise<SwidgeSupportedToken[]>`

Returns supported tokens with `symbol`, `decimals` and `name`. get-routes returns addresses only, so metadata comes from a table generated from the live route matrix (`pnpm gen:tokens`); a token not in it yet is **omitted** rather than returned with guessed decimals. `options.fromChain` filters by chain.

#### `getRequiredApproval(options: SwidgeOptions) → Promise<{ token: string, spender: string, amount: bigint } | null>`

Computes the ERC-20/TRC-20 approval that must be granted before calling `swidge()` for offramp or token-swap routes. Returns `null` for onramp routes (BTC source — no token approval needed) and when the current allowance already covers `fromTokenAmount`.

The approval is **unbounded** (`amount` is `2^256 - 1`), as Gateway V4 and `@gobob/bob-sdk` grant it, so one approval covers later orders on the same route. Because an unbounded allowance puts the whole token balance behind the spender, the spender is checked against a hardcoded table of the Gateway's AllowanceHolder contracts per source chain (0x's canonical `0x0000000000001fF3684f28c67538d4D072C22734` on most EVM chains, Gateway's own on BOB and Tron) — never trusted from the create-order response. An unknown chain or a mismatched spender throws `VALIDATION_ERROR` instead of returning an approval; `simulateSwidge()` applies the same check to the approval it reports.

The order transaction itself is held to the same standard before anything signs, in `swidge()`, `simulateSwidge()` and `getRequiredApproval()` alike: it must be `AllowanceHolder.exec(operator, token, amount, target, data)` on the pinned holder for the source chain, canonically encoded, moving the source token and at most `fromTokenAmount` of it. Native `value` beyond the swapped amount — the bridge messaging fee LayerZero OFT and CCIP token swaps pay in native — is capped by `maxNativeFee`. The quote's `srcChain` and the order's `tx.chain` must both name the requested source chain, a Tron order's `feeLimit` may not exceed 100 TRX (the gateway's own default), and amount fields must be plain decimal strings. On an onramp, the BTC amount (taken from the quote) must equal `fromTokenAmount`. A mismatch throws `VALIDATION_ERROR` (`refusing to sign the order: …`); the order already created is left to the gateway to reconcile. EVM gas is not checked: unlike Tron's `feeLimit` it is not part of the order but estimated by the account, so it is bounded by the WDK account's `transactionMaxFee` (`gasLimit × maxFeePerGas`, checked before signing) when that is set.

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

These come from WDK's `SwidgeProtocol` base class, which reduces `fees` to one `bigint` (`swap()`/`quoteSwap()`: every fee; `bridge()`/`quoteBridge()`: `network` → `fee`, `protocol` → `bridgeFee`) without looking at each fee's `token`. On token-swap routes that is `0n` (no fee breakdown). On an offramp or onramp the fee lines are in different tokens, so the summed number mixes units — read `swidge()`/`quoteSwidge()`'s `fees` instead.

## `GatewayClient`

Low-level HTTP client for the BOB Gateway V4 API. Instantiated automatically by `GatewaySwidge`. Expose it only when you need raw API access.

## Errors

Contract violations throw the WDK error classes from `@tetherto/wdk-wallet/protocols`, so they match `instanceof` against core's copy:

| Error                     | When                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `ValueError`              | `toTokenAmount` (exact-out) passed, `fromTokenAmount` or a cross-chain `recipient` missing, or a non-integer `minAmountOut`. |
| `AccountRequiredError`    | `swidge()` with an account that cannot sign on the source chain.                             |
| `SwidgeError`             | Quote below `minAmountOut` (`reason: 'COULD_NOT_MET_THRESHOLD'`). `swap()`/`bridge()` re-throw it as `SwapError`/`BridgeError`. |
| `MaximumFeeExceededError` | A fee over `maxNetworkFeeBps`/`maxProtocolFeeBps`, or a capped fee that cannot be priced.    |

Gateway, transport and payload-validation failures throw `GatewaySwidgeError`.

### `GatewaySwidgeError` / `ERR`

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

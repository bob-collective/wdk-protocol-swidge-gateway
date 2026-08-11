# AGENTS.md — @gobob/wdk-protocol-swidge-gateway

## Purpose

BOB Gateway **swidge** protocol module for the Tether Wallet Development Kit (WDK). Adds native BTC ⇄ token swap/bridge routes over the BOB Gateway V3 REST API, signing exclusively through WDK accounts. No viem, no bob-sdk.

## Commands

```sh
pnpm install        # install deps (pnpm; lockfile is committed)
pnpm build          # tsc → dist/ (ESM + .d.ts)
pnpm test           # vitest; integration suite self-skips without TEST_SEED
pnpm lint           # eslint (flat config, @typescript-eslint)
pnpm format         # prettier --write .
```

## Layout

- `src/` — TypeScript. Public entry `src/index.ts` (exports `GatewaySwidge`, `GatewayClient`, `GatewaySwidgeError`, `ERR`, `BTC`, `buildTronApproval`).
- `src/gateway-swidge.ts` — the `SwidgeProtocol` implementation · `src/gateway-client.ts` — V3 HTTP client · `src/chain-adapters/` — bitcoin/evm/tron `send` + `simulate` · `src/map/` — pure wire↔SDK mappers.
- `tests/*.test.ts` — vitest unit tests · `tests/integration/*.int.test.ts` — live, gated on `TEST_SEED`.
- `bare.js` — Bare-runtime entry (re-exports `dist`).

## Conventions

- **TypeScript + ESM** (NodeNext), prettier-formatted. Match the surrounding style.
- **Keys never leave the WDK account** — never log or serialize seeds, mnemonics, or private keys anywhere. Sign only via account methods.
- **All changes go through a branch + PR** — branch protection is on; never push directly to `main`.

## Gotchas (learned the hard way — don't re-break these)

- **The gateway `/v3` API is geo-restricted via a country blocklist** — includes the **US and UK** plus sanctioned jurisdictions ([full list in the Gateway FAQ](https://docs.gobob.xyz/gateway/faq#are-any-regions-blocked-from-using-gateway)). CI validation and the swap harness must run from a **non-blocked region**: the **EU self-hosted runner** (`bob-ubuntu-latest`) works, while **github-hosted runners are US-based and get a 403**. (This is a blocklist, not an EU allowlist — any non-blocked country is fine.)
- **Wire casing.** create-order responses, register-tx request bodies, and order-status responses are serde **enums**: the _variant keys_ are camelCase (`onramp`, `offramp`, `tokenSwap`, `inProgress`, `failed`, `success`, `refunded`) but the _fields inside_ are **snake_case** (`order_id`, `psbt_hex`, `op_return_data`, `bitcoin_tx_hex`, `src_tx_hash`, `src_chain`, `refund_tx`, `pending_btc_payment`, `received_tokens`). The quote and get-routes structs, by contrast, are camelCase. (Why: `#[serde(rename_all = "camelCase")]` on an **enum** renames only the variant names — renaming struct-variant _fields_ would need `rename_all_fields`, which the gateway does not use. Don't "fix" these to camelCase after reading the Rust attribute.) See `src/map/`.
- **BTC signing.** WDK `WalletAccountBtc.signTransaction` returns a **hex string**, not a bitcoinjs `Transaction` — parse with `Transaction.fromHex(hex)` for the txid. The gateway broadcasts the BTC tx (via register-tx); the client does not.
- **BTC token id.** Pass `'BTC'` (or the exported `BTC` constant) as `fromToken`/`toToken`; it's normalized to the native zero-address internally. ERC-20/TRC-20 tokens are their contract address.
- **Tron order calls must be pre-built, not passed as descriptors.** The gateway returns pre-encoded calldata — `offramp.tx` is an internally-tagged `GatewayTxData`, i.e. `type` (`evm` | `tron` | `solana`) plus `to` (Base58Check `T…` for Tron), `data`, `value`, `chain`, `feeLimit`. A missing `type` means EVM (older responses). tronweb accepts raw calldata only via `options.input` **with an empty `functionSelector`** — but `wdk-wallet-tron` routes its `{contractAddress, functionSelector}` descriptor on `!!tx.functionSelector`, so that branch can never carry raw calldata. `src/chain-adapters/tron.ts` therefore builds the tx with `triggerSmartContract(to, '', {input, callValue, feeLimit}, [], owner)` and hands the account a **pre-built** tx (detected by `txID`; the account still owner-checks it). `feeLimit`/`callValue` must be JS integers — tronweb's validator rejects strings, and `feeLimit` must be > 0.
- **Tron needs a tronweb instance and there's no public accessor.** The adapter reads `account._tronWeb` (private in wdk-wallet-tron) so integrators get the account's own failover-aware node by default; `config.tronWeb` / `config.tronProvider` override it. Same story for allowances — `WalletAccountTron` has no `getAllowance`/`approve`, so `allowance()` is a `triggerConstantContract` read and `approve()` goes out through `buildTronApproval()` (a descriptor, since we _do_ know that selector).
- **The built Tron tx is re-checked before it reaches the signer.** `WalletAccountTron._signTransaction` signs `transaction.txID` and nothing else, and its only sanity check is that `owner_address` is ours — the target, calldata and amounts reach the signer unexamined. A real tronweb instance already guards this (`resultManagerTriggerSmartContract` → `txCheckWithArgs` rebuilds the protobuf from the **locally** supplied args and rejects a response whose `raw_data_hex`/`txID` differ), but that is not enough on its own: `TronWebLike` is structural, so a caller-supplied object does no such check, and `tronweb: ^6` makes no promise about other 6.x releases. `assertBuiltTxMatches` re-asserts contract type/count, owner, target, calldata, call value and fee limit, binds `raw_data` to `txID` via `utils.transaction.txCheck`, rejects an already-signed response (wdk skips building, the owner check and signing when `tx.signature` is set), rejects the two other fields that ride into the signed bytes unasked (`raw_data.data`, a free-form memo, and `Permission_id`, which routes the call through a multisig permission we never inspected) and bounds the node-supplied `expiration`/`timestamp` — present, in order, not already elapsed, window ≤ 10min — so a hostile node can't stretch the replay window.
- **A Tron node reports failure in the envelope, not by throwing.** `triggerSmartContract`/`triggerConstantContract` resolve with `result.result: false` and/or a top-level `Error`, _and can still carry_ a `transaction`/`constant_result`, so the payload's presence proves nothing — `assertNodeAccepted` reads the status first. Same reason `allowance()` is checked for exactly one 32-byte hex word before `BigInt`: revert data parses as a valid, enormous integer, which would read as "allowance already covers it" and skip the approval the swap then needs.
- **The adapter is chosen by route, the payload branch by `tx.type`.** Two independent sources for the same fact, so `assertPayloadFamily` (in `src/gateway-swidge.ts`) makes them agree before dispatch — otherwise a `tron` order on an EVM route (or an untyped, i.e. EVM, order on a Tron route) reaches the wrong adapter and the wrong signer.
- **`ownerAddress` is always an Ethereum address, even on Tron routes.** get-quote requires it on every route (omitting it is `MISSING_OWNER_ADDRESS`) and validates it with an EVM address parser, so a Base58Check owner is a hard `400 INVALID_REQUEST: Invalid Ethereum address` — on a Tron offramp _and_ on a BTC onramp whose recipient is on Tron. This is asymmetric: `sender`/`recipient`/`txTo` on the very same request stay Base58Check. `src/address.ts` converts by decoding the Base58Check payload (`0x41 || hash160(pubkey)`) and re-emitting the 20 bytes as `0x…` — the same account, a different spelling, no second key involved. Don't "fix" this by converting `sender` too, and don't reach for tronweb to do it: `bitcoinjs-lib`'s `fromBase58Check` is already in the static graph and Tron uses the identical checksum scheme.
- **Tron txids go on the wire bare.** `sendTransaction` returns the Tron txid without `0x`; register-tx parses it with alloy's `TxHash::from_str`, which accepts both forms — no normalization needed.
- **`@tetherto/wdk-wallet` must stay a peerDependency — never a regular dependency.** WDK core's `registerProtocol` dispatches on `Protocol.prototype instanceof SwidgeProtocol` and has **no `else` branch**: a class that fails the check is dropped _silently_, surfacing much later as `No swidge protocol registered for label: gateway`. The check runs against the copy of `@tetherto/wdk-wallet` that **core** resolves, so if we ship our own pinned copy, npm installs two copies, the base class gets two identities, and every consumer using the documented core wiring breaks. The in-repo test suite **cannot** catch this (our dev tree only ever has one copy, so `instanceof` passes trivially) — that's what `pnpm verify:consumer` (`scripts/verify-consumer.mjs`, run in CI) is for: it packs the tarball into a throwaway consumer tree next to `@tetherto/wdk` and asserts the module survives registration.

## Testing & CI

- The **validate lane** (`.github/workflows/validate.yml`) runs on push/PR: real quotes + sign/simulate against mainnet, **no swap**. Secrets come from the **`WDK Gateway` 1Password vault** (`op://WDK Gateway/seed/mnemonic`) via the `OP_SERVICE_ACCOUNT_TOKEN` repo secret.
- `scripts/execute-swap.ts` + `.github/workflows/execute-swap.yml` run a **real, spendful** round-trip, guarded by `confirm: yes-spend-real-funds`.
- Locally: `op run --env-file=.env.op -- pnpm exec vitest run tests/integration`.

## Release

Bump `version`, merge to `main`, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The `npm-publish.yml` workflow builds, tests, and publishes to npm via **OIDC trusted publishing** (token-less, with signed provenance). It skips automatically if that version is already published.

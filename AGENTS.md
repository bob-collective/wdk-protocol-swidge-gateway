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
- `src/` — TypeScript. Public entry `src/index.ts` (exports `GatewaySwidge`, `GatewayClient`, `GatewaySwidgeError`, `ERR`, `BTC`).
- `src/gateway-swidge.ts` — the `SwidgeProtocol` implementation · `src/gateway-client.ts` — V3 HTTP client · `src/chain-adapters/` — bitcoin/evm/tron `send` + `simulate` · `src/map/` — pure wire↔SDK mappers.
- `tests/*.test.ts` — vitest unit tests · `tests/integration/*.int.test.ts` — live, gated on `TEST_SEED`.
- `bare.js` — Bare-runtime entry (re-exports `dist`).

## Conventions
- **TypeScript + ESM** (NodeNext), prettier-formatted. Match the surrounding style.
- **Keys never leave the WDK account** — never log or serialize seeds, mnemonics, or private keys anywhere. Sign only via account methods.
- **All changes go through a branch + PR** — branch protection is on; never push directly to `main`.

## Gotchas (learned the hard way — don't re-break these)
- **The gateway `/v3` API is geo-restricted via a country blocklist** — includes the **US and UK** plus sanctioned jurisdictions ([full list in the Gateway FAQ](https://docs.gobob.xyz/gateway/faq#are-any-regions-blocked-from-using-gateway)). CI validation and the swap harness must run from a **non-blocked region**: the **EU self-hosted runner** (`bob-ubuntu-latest`) works, while **github-hosted runners are US-based and get a 403**. (This is a blocklist, not an EU allowlist — any non-blocked country is fine.)
- **Wire casing.** create-order responses, register-tx request bodies, and order-status responses are serde **enums**: the *variant keys* are camelCase (`onramp`, `offramp`, `tokenSwap`, `inProgress`, `failed`, `success`, `refunded`) but the *fields inside* are **snake_case** (`order_id`, `psbt_hex`, `op_return_data`, `bitcoin_tx_hex`, `src_tx_hash`, `src_chain`, `refund_tx`, `pending_btc_payment`, `received_tokens`). The quote and get-routes structs, by contrast, are camelCase. See `src/map/`.
- **BTC signing.** WDK `WalletAccountBtc.signTransaction` returns a **hex string**, not a bitcoinjs `Transaction` — parse with `Transaction.fromHex(hex)` for the txid. The gateway broadcasts the BTC tx (via register-tx); the client does not.
- **BTC token id.** Pass `'BTC'` (or the exported `BTC` constant) as `fromToken`/`toToken`; it's normalized to the native zero-address internally. ERC-20/TRC-20 tokens are their contract address.

## Testing & CI
- The **validate lane** (`.github/workflows/validate.yml`) runs on push/PR: real quotes + sign/simulate against mainnet, **no swap**. Secrets come from the **`WDK Gateway` 1Password vault** (`op://WDK Gateway/seed/mnemonic`) via the `OP_SERVICE_ACCOUNT_TOKEN` repo secret.
- `scripts/execute-swap.ts` + `.github/workflows/execute-swap.yml` run a **real, spendful** round-trip, guarded by `confirm: yes-spend-real-funds`.
- Locally: `op run --env-file=.env.op -- pnpm exec vitest run tests/integration`.

## Release
Bump `version`, merge to `main`, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The `npm-publish.yml` workflow builds, tests, and publishes to npm via **OIDC trusted publishing** (token-less, with signed provenance). It skips automatically if that version is already published.

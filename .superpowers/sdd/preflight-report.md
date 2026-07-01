# Pre-funds preflight harness — implementation report

## Files created

| File | Purpose |
|---|---|
| `scripts/preflight.js` | Read-only/dry-run harness (Phases A–C). Run from a normal machine. |
| `scripts/e2e-onramp.js` | Funded BTC→USDT-Eth script. Gated by two env vars. |
| `scripts/e2e-offramp.js` | Funded USDT-Eth→BTC script. Gated by two env vars. Handles USDT reset-to-0. |
| `scripts/README.md` | Env vars, phased approach, differential-oracle commands, Cloudflare note. |

`package.json` updated: added `"preflight": "node scripts/preflight.js"` script and added `@tetherto/wdk-wallet-{btc,evm,evm-erc-4337}` to devDependencies.

## What each script does

### `scripts/preflight.js`

**Phase A** — calls `getRoutes()` and asserts the `bitcoin→ethereum / BTC_ZERO→USDT_ETH` route is present; calls `quoteSwidge()` for both onramp and offramp, asserts `toTokenAmount > 0`. Prints amounts and fees.

**Phase B** — uses `GatewayClient` directly to call `getQuote()` + `createOrder()` for both variants. Prints the returned `orderId` and deposit address (onramp) or spender `tx.to` (offramp). Clearly labels these as orphaned.

**Phase C** — only if `BTC_SEED`/`EVM_SEED` are set. Constructs real WDK accounts using the constructor APIs below, derives and prints addresses, then calls `getRequiredApproval()` (reads real USDT allowance on-chain, no broadcast). All failures in Phase C are caught and reported without crashing.

Each check prints `✓`/`✗`; script exits non-zero if any check failed.

### `scripts/e2e-onramp.js`

Refused to run unless `GATEWAY_E2E=1` AND `I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes`. Constructs a real BTC account from `BTC_SEED`, prints a preview quote, waits 5 s, calls `swidge()`, then polls `getSwidgeStatus()` to completion or timeout.

### `scripts/e2e-offramp.js`

Same guards. Constructs a real EVM account from `EVM_SEED`. Calls `getRequiredApproval()`; if approval is needed, performs reset-to-0 then approve (required for USDT's non-standard ERC-20). Prints preview quote, waits 5 s, calls `swidge()`, polls to completion.

## Run commands

```sh
# Preflight (no funds)
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… node scripts/preflight.js

# With WDK account wiring (Phase C)
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… BTC_SEED="…" EVM_SEED="…" node scripts/preflight.js

# Funded onramp (use small amount first)
GATEWAY_E2E=1 I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes \
  BTC_SEED="…" EVM_ADDRESS=0x… AMOUNT_SATS=100000 \
  node scripts/e2e-onramp.js

# Funded offramp
GATEWAY_E2E=1 I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes \
  EVM_SEED="…" BTC_ADDRESS=bc1q… AMOUNT_USDT=5000000 \
  node scripts/e2e-offramp.js
```

## WDK account constructor APIs found

**BTC** (`@tetherto/wdk-wallet-btc`):
```js
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
const wallet = new WalletManagerBtc(seedPhrase, {
  client: { type: 'blockbook-http', clientConfig: { url: 'https://btc1.trezor.io/api' } },
  network: 'bitcoin'
})
const account = await wallet.getAccount(0) // BIP-84, index 0
const address = await account.getAddress() // Native SegWit bech32
```

**EVM** (`@tetherto/wdk-wallet-evm`):
```js
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
const wallet = new WalletManagerEvm(seedPhrase, {
  provider: 'https://eth.drpc.org' // mainnet JSON-RPC
})
const account = await wallet.getAccount(0) // BIP-44, m/44'/60', index 0
const address = await account.getAddress()
```

## Status at time of writing

- `pnpm lint`: passes (standard v17.1.2)
- `pnpm test`: 57 pass, 1 skipped (unchanged)
- Live API calls from this sandbox environment: blocked by Cloudflare WAF (expected). Scripts fail gracefully with a clear `✗` line when the API is unreachable.

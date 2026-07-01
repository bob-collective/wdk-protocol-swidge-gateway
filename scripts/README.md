# Pre-funds preflight harness

Test the swidge module against the real BOB Gateway V3 API **without** moving funds.

## Phased approach

Run the phases in order. Each phase gates the next.

```
Phase A  ─► Phase B  ─► differential oracle  ─► Phase C  ─► funded e2e
(read-only)  (orphaned)   (compare CLI output)   (WDK acct)  (LAST)
```

### Phase A — live wire conformance

No orders created. No funds required.

- `getRoutes()` asserts the BTC→USDT-Ethereum route is live.
- `getSupportedChains()` asserts bitcoin + ethereum are present.
- `quoteSwidge()` onramp (BTC→USDT) asserts `toTokenAmount > 0`.
- `quoteSwidge()` offramp (USDT→BTC) asserts `toTokenAmount > 0`.

### Phase B — dry-run orders

**Orphaned order IDs are created** (both onramp and offramp). No funds are moved because no transaction is broadcast. These orders will remain unfulfilled and eventually expire.

Uses `GatewayClient` directly to exercise `getQuote` → `createOrder` for both variants.

### Differential oracle step

After Phase A and Phase B pass, compare quote output between the gateway-cli and this module. Run both commands on a normal machine (not CI with blocked egress — see Cloudflare note below).

**Onramp (BTC → USDT):**

```sh
# gateway-cli
gateway-cli quote btc --amount 1000000 --to usdt --to-chain ethereum

# this module
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… AMOUNT_SATS=1000000 node scripts/preflight.js 2>&1 | grep -A4 "A2:"
```

**Offramp (USDT → BTC):**

```sh
# gateway-cli
gateway-cli quote usdt --chain ethereum --amount 50 --to btc

# this module
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… AMOUNT_USDT=50000000 node scripts/preflight.js 2>&1 | grep -A4 "A3:"
```

Compare `toTokenAmount` and fee breakdown between the two outputs. Any discrepancy indicates a mapping bug in `src/map/quote.js`.

### Phase C — WDK account wiring

Only runs if `BTC_SEED` and/or `EVM_SEED` env vars are set. Derives real BTC and EVM addresses from the seed phrases and compares to `BTC_ADDRESS`/`EVM_ADDRESS`. Calls `getRequiredApproval` on mainnet (reads real USDT allowance from the Ethereum RPC). No broadcast.

### Funded e2e — LAST

Run `e2e-onramp.js` and `e2e-offramp.js` only after all earlier phases pass. Both scripts are gated by two mandatory env vars and print the amounts before broadcasting with a 5-second abort window.

## Cloudflare note

The BOB Gateway `/v3` endpoint is Cloudflare WAF-protected. It is **not reachable from CI environments** with restricted egress (e.g., GitHub Actions sandbox). Run all scripts from a normal developer machine. This is expected and not a bug.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GATEWAY_API_URL` | no | `https://gateway-api-mainnet.gobob.xyz` | Override Gateway API base URL |
| `GATEWAY_API_KEY` | no | BOB attribution key | API key |
| `BTC_ADDRESS` | recommended | placeholder | BTC address for offramp recipient / Phase C comparison |
| `EVM_ADDRESS` | recommended | `0x…0001` | EVM address for onramp recipient / Phase C comparison |
| `BTC_SEED` | Phase C + e2e-onramp | — | BIP-39 seed phrase for BTC account |
| `EVM_SEED` | Phase C + e2e-offramp | — | BIP-39 seed phrase for EVM account |
| `AMOUNT_SATS` | no | `1000000` | Satoshis for onramp quote / e2e |
| `AMOUNT_USDT` | no | `50000000` | USDT in 6dp for offramp quote / e2e |
| `GATEWAY_E2E` | e2e scripts only | — | Must be `1` to run funded scripts |
| `I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS` | e2e scripts only | — | Must be `yes` to run funded scripts |
| `FEE_RATE` | no | wallet default | sat/vByte fee rate for e2e-onramp |
| `EVM_PROVIDER` | no | `https://eth.drpc.org` | Ethereum JSON-RPC URL for e2e-offramp |
| `POLL_INTERVAL_MS` | no | `15000` | e2e status poll interval |
| `POLL_TIMEOUT_MS` | no | `1800000` | e2e total poll timeout (30 min) |

## Commands

**Run preflight (all phases A–C):**

```sh
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… node scripts/preflight.js
# or via package script:
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… pnpm preflight
```

**Run preflight with WDK account wiring (Phase C):**

```sh
BTC_ADDRESS=bc1q… EVM_ADDRESS=0x… \
  BTC_SEED="word1 word2 …" \
  EVM_SEED="word1 word2 …" \
  node scripts/preflight.js
```

**Run funded onramp (BTC → USDT):**

```sh
GATEWAY_E2E=1 I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes \
  BTC_SEED="word1 word2 …" \
  EVM_ADDRESS=0x… \
  AMOUNT_SATS=100000 \
  node scripts/e2e-onramp.js
```

**Run funded offramp (USDT → BTC):**

```sh
GATEWAY_E2E=1 I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS=yes \
  EVM_SEED="word1 word2 …" \
  BTC_ADDRESS=bc1q… \
  AMOUNT_USDT=5000000 \
  node scripts/e2e-offramp.js
```

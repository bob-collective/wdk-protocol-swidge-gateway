# Gateway Integration Tests

Two integration suites live here:

| Suite | Gate variable | Purpose |
|-------|--------------|---------|
| `validate.int.test.ts` | `TEST_SEED` | Quote + simulate (no broadcast) |
| `onramp.int.test.ts` | `GATEWAY_INT=1` | End-to-end onramp against a test endpoint |

Both suites are **opt-in** — when the gate variable is absent the entire `describe`
block is skipped and the runner exits green.

## Running Locally

### Validation suite (quote + simulate, no swap)

Requires a BIP-39 mnemonic in `TEST_SEED`. The easiest way is via 1Password CLI:

```bash
op run --env-file=.env.op -- pnpm exec vitest run tests/integration/validate.int.test.ts
```

Or export the seed directly:

```bash
export TEST_SEED="your twelve word mnemonic ..."
export EVM_RPC_URL="https://ethereum-rpc.publicnode.com"   # optional, has default
export TRON_RPC_URL="https://tron-rpc.publicnode.com"      # optional, has default
pnpm exec vitest run tests/integration/validate.int.test.ts
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TEST_SEED` | **yes** | — | BIP-39 mnemonic — derives BTC (BIP-84), EVM, and Tron accounts |
| `EVM_RPC_URL` | no | `https://ethereum-rpc.publicnode.com` | JSON-RPC for Ethereum |
| `TRON_RPC_URL` | no | `https://tron-rpc.publicnode.com` | Tron full-node endpoint |
| `AMOUNT_SATS` | no | `30000` | BTC onramp amount (satoshis) |
| `AMOUNT_USDT` | no | `50000000` | USDT offramp amount (6-decimal) |
| `AMOUNT_ETH` | no | `20000000000000000` | ETH offramp amount (wei, simulated only) |

### Onramp suite (end-to-end, test endpoint)

```bash
GATEWAY_INT=1 pnpm exec vitest run tests/integration/onramp.int.test.ts
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_INT` | **yes** | — | Set to `'1'` to enable |
| `GATEWAY_TEST_URL` | yes | — | Gateway test endpoint URL |
| `TEST_TOKEN` | yes | — | Destination token (`USDT`, `USDC`, …) |
| `TEST_CHAIN` | yes | — | Destination chain (`base`, `ethereum`, …) |
| `TEST_RECIPIENT` | yes | — | Recipient address on the destination chain |

## CI

In GitHub Actions the validation suite runs on every push and PR via
`.github/workflows/validate.yml`. Secrets are injected from 1Password
(`op://WDK Gateway/seed/mnemonic`).

The onramp suite is not wired into CI yet.

# Testing the WDK Gateway module

## Phased approach

| Phase | What runs | What it validates | Requires a funded wallet? |
|-------|-----------|-------------------|--------------------------|
| Unit (CI on every PR) | `pnpm test` (all `*.test.ts`, integration skipped) | Types, mapping, adapter logic, mocked HTTP | No |
| **Validation lane** (this doc) | `pnpm exec vitest run tests/integration` | Quote conformance + sign/simulate (no broadcast) | Yes — seed must be funded |
| Live swap (gateway-bot) | gateway-bot full swap flow | End-to-end swap including broadcast | Yes — full funded wallet |

The validation lane is the "everything short of the swap" layer: it hits the real Gateway V3 API for quotes, constructs real signed BTC transactions and EVM gas estimates, but **never broadcasts** and **never calls registerTx**.

---

## 1. Create the `WDK Gateway` 1Password vault

1. In your 1Password account, create a new vault called exactly **`WDK Gateway`**.
2. Create a **Login** item named `test-seed`:
   - Field name: `password`
   - Value: your BIP-39 mnemonic (12 or 24 words)
3. Create a **Login** item named `rpc-ethereum`:
   - Field name: `password`
   - Value: an Ethereum JSON-RPC URL (e.g. a Tenderly virtual testnet URL or `https://eth.llamarpc.com`)

   > Tip: for the offramp `simulateSwidge` to return `valid: true` without a standing USDT approval, point `rpc-ethereum` at a [Tenderly virtual testnet](https://docs.tenderly.co/virtual-testnets) that has the test account's USDT allowance pre-set. Without this, `valid: false` + `requiredApproval` is returned — which is an expected and accepted outcome in the test suite.

---

## 2. Create a 1Password service account

1. Go to **Integrations → Developer Tools → Service Accounts** in the 1Password web app.
2. Create a service account with read access to the `WDK Gateway` vault.
3. Copy the `OP_SERVICE_ACCOUNT_TOKEN` token value.

---

## 3. Add the `OP_SERVICE_ACCOUNT_TOKEN` repository secret

```
gh secret set OP_SERVICE_ACCOUNT_TOKEN --body "<paste token here>"
```

Or via the GitHub UI: **Settings → Secrets and variables → Actions → New repository secret**.

---

## 4. Fund the two wallet addresses

Derive the addresses from your seed (requires the 1Password CLI):

```bash
op run --env-file=.env.op -- pnpm derive-addresses
```

You will see output like:

```
BTC address (BIP-84 / bc1…): bc1q…
EVM address: 0x…
```

Fund them:
- **BTC address** — send at least 30 000 sats (~0.0003 BTC) to cover the `AMOUNT_SATS` default plus fees. This fits a ~$50 test wallet; bump `AMOUNT_SATS` if you funded more.
- **EVM address** — send at least 50 USDT (`AMOUNT_USDT` default = 50 000 000 in 6-decimal units) and a small amount of ETH for gas estimation (≥ 0.001 ETH).

---

## 5. Run the integration suite locally

```bash
op run --env-file=.env.op -- pnpm exec vitest run tests/integration
```

Optional overrides:

```bash
# Larger amounts
AMOUNT_SATS=200000 AMOUNT_USDT=100000000 \
  op run --env-file=.env.op -- pnpm exec vitest run tests/integration
```

---

## 6. Self-skip behaviour (no TEST_SEED)

When `TEST_SEED` is not set, the integration suite reports all its tests as **skipped**, not failed:

```
↓ tests/integration/validate.int.test.ts (5 tests | 5 skipped)
```

This is the expected behaviour in PR CI where secrets are not injected.

---

## 7. Offramp `requiredApproval` behaviour

The offramp `simulateSwidge` test accepts two valid outcomes:

| Outcome | When it happens |
|---------|----------------|
| `valid: true`, `requiredApproval: null` | Account already has a standing USDT allowance, or `EVM_RPC_URL` points at a Tenderly virtual testnet with state-override |
| `valid: false`, `requiredApproval: { token, spender, amount }` | No standing USDT allowance on the account (normal for a fresh wallet on mainnet) |

A third outcome — `valid: false`, `requiredApproval: null` — would indicate a hard error and causes the test to fail.

To move to the first outcome without a real on-chain approval, configure `rpc-ethereum` in 1Password to point at a Tenderly virtual testnet URL that has the account's USDT allowance pre-set as a state override (a future enhancement to this lane).

---

## 8. Executing a real swap (mainnet, real funds)

> **Warning:** the steps below broadcast real mainnet transactions and move real money. Follow the phase order and read each step carefully.

### Overview of the three phases

| Phase | `PHASE=` | What it does | Irreversible? |
|-------|---------|--------------|--------------|
| **onramp** | `onramp` | BTC → USDT@Ethereum — builds and broadcasts a BTC transaction | Yes |
| **offramp** | `offramp` | USDT@Ethereum → BTC — checks/waits for ERC-20 approval, then broadcasts an EVM tx | Yes |
| **status** | `status` | Read-only — prints order status, EVM USDT balance, and BTC address | No |

### Recommended sequence

1. Run `pnpm derive-addresses` (or the **derive test addresses** workflow) to confirm the funded wallet addresses.
2. **Onramp:** trigger the workflow with `phase=onramp` and `amount=<sats>`. Copy the `ORDER_ID` from the run log.
3. **Wait for settlement:** monitor the onramp order via `phase=status` and `order_id=<ORDER_ID>` until `status` shows the swap is complete (funds arrive on Ethereum). Do not proceed to offramp until settlement is confirmed — use public block explorers or the status phase to verify.
4. **Offramp:** trigger the workflow with `phase=offramp` and `amount=<USDT 6dp>`. The script will handle ERC-20 approval automatically (polling up to 5 minutes for the approval tx to mine) before sending the swap tx.

### The `confirm` guard

The workflow requires the `confirm` input to be set to exactly `yes-spend-real-funds`. If any other value (or blank) is supplied the job exits immediately with an error before any secrets are loaded or any transaction is built. This prevents accidental runs from UI mis-clicks.

The guard input is read via an `env:` variable in the workflow — it is never interpolated directly into a `run:` string, which prevents shell-injection attacks.

### Running locally

```bash
# Build first (the script imports from dist/)
pnpm build

# Onramp example (30 000 sats)
TEST_SEED="<mnemonic>" PHASE=onramp AMOUNT=30000 pnpm execute-swap

# Status check
TEST_SEED="<mnemonic>" PHASE=status ORDER_ID=<id> pnpm execute-swap

# Offramp example (50 USDT = 50 000 000 in 6dp)
TEST_SEED="<mnemonic>" PHASE=offramp AMOUNT=50000000 pnpm execute-swap
```

Use `op run` to inject the seed from 1Password instead of exporting it to the shell:

```bash
op run --env-file=.env.op -- pnpm execute-swap
```

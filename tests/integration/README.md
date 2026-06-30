# Gateway Integration Tests

These tests drive real `quoteSwidge` calls against a live Gateway test endpoint. They are **opt-in** and skipped by default to avoid hitting the network during normal test runs.

## Running Integration Tests

Integration tests are **only enabled** when `GATEWAY_INT=1` is set:

```bash
GATEWAY_INT=1 pnpm test tests/integration
```

## Environment Variables

To run the integration tests, configure these variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `GATEWAY_INT` | **Required**: Set to `'1'` to enable tests. Omit or set to anything else to skip. | `GATEWAY_INT=1` |
| `GATEWAY_TEST_URL` | Gateway test endpoint URL | `https://gateway-test.example.com` |
| `TEST_TOKEN` | Token to swap to (e.g., USDT, USDC) | `USDT` |
| `TEST_CHAIN` | Destination chain (e.g., base, ethereum) | `base` |
| `TEST_RECIPIENT` | Recipient address on destination chain | `0x...` |

## CI / Secrets

In CI environments (GitHub Actions, etc.), integration tests run only when **all required secrets** are present and `GATEWAY_INT` is set. This keeps the test suite isolated from the network by default.

Example CI setup:
```yaml
- name: Run integration tests (if secrets available)
  if: env.GATEWAY_INT == '1'
  env:
    GATEWAY_INT: ${{ secrets.GATEWAY_INT }}
    GATEWAY_TEST_URL: ${{ secrets.GATEWAY_TEST_URL }}
    TEST_TOKEN: ${{ secrets.TEST_TOKEN }}
    TEST_CHAIN: ${{ secrets.TEST_CHAIN }}
    TEST_RECIPIENT: ${{ secrets.TEST_RECIPIENT }}
  run: pnpm test tests/integration
```

## Test Endpoints

Tests use signet/regtest Bitcoin accounts. Gateway test endpoint should support:
- Testnet chains (Base Sepolia, etc.)
- Testnet tokens (e.g., test USDT)
- Signet/regtest Bitcoin inputs

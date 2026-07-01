# Overview — @gobob/wdk-protocol-swidge-gateway

## About

`@gobob/wdk-protocol-swidge-gateway` is a WDK protocol module that adds cross-chain "swidge" capability (swap + bridge in a single operation) to any WDK wallet account. It is backed by the BOB Gateway V3 API.

A **swidge** converts an asset on one chain and delivers a different asset on another chain atomically from the user's perspective. The gateway handles routing, quoting, order creation, and settlement.

## Supported Routes

| Route | Direction | Notes |
|-------|-----------|-------|
| BTC ↔ EVM chains | Bidirectional | Full support including affiliate fees |
| BTC → Tron | Destination only | Tron-as-source not in v1 ([tracking issue](https://github.com/tetherto/wdk-wallet-tron/issues/48)) |
| EVM ↔ EVM | Bidirectional | Use inherited `swap()` / `bridge()` methods. Affiliate fees not supported. |
| Solana | Coming soon | Not available in v1 |

## Key Concepts

### Non-custodial Design

Keys never leave the WDK account. `GatewaySwidge` delegates all signing to the account layer — it never directly accesses private keys. The package has no dependency on `viem` or `@gobob/bob-sdk`.

### BOB Attribution

The default `bearerToken` is BOB's gateway-wdk attribution token. It attributes gateway-wdk swap volume to BOB at 0 cost to you or your users. This is separate from affiliate fees.

### Affiliate Fees

Partners can earn basis-point fees on BTC ↔ EVM routes by setting `config.affiliates`. Limits:

- At most **5 entries**.
- Total fees **≤ 1000 bps** (10%).
- Each entry must have `bps > 0` and a unique, non-zero address.
- EVM↔EVM routes do not support affiliate fees — they are dropped gracefully.

### ERC-20 Approval (Offramp / Token Swap)

For routes where the user sends an ERC-20 token (offramp: token → BTC; token swap: token → token), the token must be approved to the gateway spender address before calling `swidge()`. Use `getRequiredApproval(options)` to retrieve the exact `{token, spender, amount}` to approve.

### Runtimes

The module works in Node.js, Bare (via `bare.js`), and React Native.

## Installation

```bash
pnpm add @gobob/wdk-protocol-swidge-gateway
```

## Quick Start

```js
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

// BTC → USDT on Base
const sw = new GatewaySwidge(account, { fromChain: 'bitcoin' })
const result = await sw.swidge({
  fromToken: 'BTC',
  toToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  toChain: 'base',
  recipient: '0xYourAddress',
  fromTokenAmount: 100000n // satoshis
})
console.log(result.id, result.hash)
```

See the [API Reference](./api-reference.md) for the full method and type documentation.

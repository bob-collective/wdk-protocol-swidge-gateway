# AGENTS.md — @gobob/wdk-protocol-swidge-gateway

## Purpose
BOB Gateway swidge module for the Tether Wallet Development Kit. Provides native BTC ⇄ token swap routes via the BOB Gateway.

## Commands

```sh
pnpm install          # install dependencies
pnpm lint             # check code style (standard)
pnpm lint:fix         # auto-fix lint issues
pnpm build:types      # emit TypeScript declarations to types/
pnpm test             # run jest test suite
pnpm test:coverage    # run jest with coverage report
```

## Conventions

- Match WDK conventions: ESM modules, `bare-node-runtime` entry via `bare.js`, standard JS style (no semicolons, 2-space indent).
- Source lives under `src/`. Entry point re-exports from `src/gateway-swidge.js`.
- Tests live under `tests/` and use the `.test.js` suffix.
- **Keys never leave the account** — never log or serialize private keys, mnemonics, or secrets anywhere in this module.
- Dependencies: use `pnpm`. Do not commit `package-lock.json` (`.npmrc` sets `package-lock=false`).
- Solidity bindings or generated files: do not edit manually — regenerate via the appropriate make target.

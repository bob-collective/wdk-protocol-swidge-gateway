// Canonical `AllowanceHolder.exec(operator, token, amount, target, data)` calldata, as the gateway
// builds every offramp/tokenSwap order tx (bob-gateway `wrap_via_allowance_holder`).
import { toHexAddress } from '../../src/allowance-holder.js'
import { USDT } from './tron.js'

export const CANONICAL_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'
/** Stand-in GatewayRouter (exec's operator and target). */
export const ROUTER = '0x' + 'ab'.repeat(20)
/** USDC on Base. */
export const EVM_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

export function execData({
  token,
  amount,
  operator = ROUTER,
  target = ROUTER,
  inner = '0xdeadbeef',
}: {
  token: string
  amount: bigint
  operator?: string
  target?: string
  inner?: string
}): string {
  const body = inner.replace(/^0x/, '')
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, '0')
  return (
    '0x2213bc0b' +
    word(toHexAddress(operator) ?? operator) +
    word(toHexAddress(token) ?? token) +
    word(amount.toString(16)) +
    word(toHexAddress(target) ?? target) +
    word((5 * 32).toString(16)) +
    word((body.length / 2).toString(16)) +
    padded
  )
}

/** exec calldata moving 1 USDT (Tron) — the Tron order tx used across the tron route tests. */
export const TRON_EXEC = execData({ token: USDT, amount: 1_000_000n })
/** Same, without `0x`, as it sits in a built Tron tx's `raw_data`. */
export const TRON_EXEC_HEX = TRON_EXEC.slice(2)

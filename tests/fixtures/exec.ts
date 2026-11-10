// Canonical `AllowanceHolder.exec(operator, token, amount, target, data)` calldata, as the gateway
// builds every offramp/tokenSwap order tx (bob-gateway `wrap_via_allowance_holder`).
import { utils } from 'tronweb'

export const CANONICAL_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'
/** Stand-in GatewayRouter (exec's operator and target). */
export const ROUTER = '0x' + 'ab'.repeat(20)
/** USDC on Base. */
export const EVM_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

/** The 20 address bytes of an EVM `0x…` or Tron Base58Check address, as hex. */
const address = (a: string) => (a.startsWith('T') ? utils.address.toHex(a).slice(2) : a)

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
    word(address(operator)) +
    word(address(token)) +
    word(amount.toString(16)) +
    word(address(target)) +
    word((5 * 32).toString(16)) +
    word((body.length / 2).toString(16)) +
    padded
  )
}

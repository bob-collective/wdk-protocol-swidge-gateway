import { address as btcAddress } from 'bitcoinjs-lib'
import { GatewaySwidgeError, ERR } from './errors.js'

/** uint256 max — the allowance Gateway V4 asks for, as `@gobob/bob-sdk` grants it. */
export const MAX_UINT256 = (1n << 256n) - 1n

/** 0x Protocol's canonical AllowanceHolder singleton, pre-deployed on most supported EVM chains. */
const ALLOWANCE_HOLDER_0X_CANONICAL = '0x0000000000001ff3684f28c67538d4d072c22734'

/** Gateway self-deployed AllowanceHolder, for chains without 0x's vanity deployment. */
const ALLOWANCE_HOLDER_SELF_DEPLOYED = '0x8fd545b348e84deb145f0179a00c671f0b9519c3'

/** Gateway self-deployed AllowanceHolder on Tron (`TAfbit1ENsRmtZbPQfYU3srURpfYuWYS7K`). */
const ALLOWANCE_HOLDER_TRON = '0x07a39ae4c49dee86e892450b20881f32cd5d500d'

// Mirrors bob-sdk `sdk/src/gateway/allowance-holder.ts`. Keep the two in step.
const ALLOWANCE_HOLDER_BY_CHAIN: Record<string, string> = {
  bob: ALLOWANCE_HOLDER_SELF_DEPLOYED,
  tron: ALLOWANCE_HOLDER_TRON,
  ethereum: ALLOWANCE_HOLDER_0X_CANONICAL,
  base: ALLOWANCE_HOLDER_0X_CANONICAL,
  bsc: ALLOWANCE_HOLDER_0X_CANONICAL,
  arbitrum: ALLOWANCE_HOLDER_0X_CANONICAL,
  avalanche: ALLOWANCE_HOLDER_0X_CANONICAL,
  unichain: ALLOWANCE_HOLDER_0X_CANONICAL,
  plasma: ALLOWANCE_HOLDER_0X_CANONICAL,
  polygon: ALLOWANCE_HOLDER_0X_CANONICAL,
  hyperevm: ALLOWANCE_HOLDER_0X_CANONICAL,
  // Staging names the same chain (id 999) `hyperliquid`; accept both spellings.
  hyperliquid: ALLOWANCE_HOLDER_0X_CANONICAL,
  robinhood: ALLOWANCE_HOLDER_0X_CANONICAL,
}

const TRON_VERSION_BYTE = 0x41
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const EVM_HEX = /^0x[0-9a-fA-F]{40}$/

/** Lower-case `0x…` form of an EVM or Tron (Base58Check) address, or null if it is neither. */
function toHexAddress(addr: string): string | null {
  if (EVM_HEX.test(addr)) return addr.toLowerCase()
  if (!TRON_BASE58.test(addr)) return null
  try {
    const { version, hash } = btcAddress.fromBase58Check(addr)
    return version === TRON_VERSION_BYTE ? '0x' + Buffer.from(hash).toString('hex') : null
  } catch {
    return null
  }
}

/**
 * Throw unless `spender` is the AllowanceHolder the Gateway uses on `chain`.
 *
 * Approvals are unbounded (`MAX_UINT256`), so the spender is checked against a hardcoded table
 * instead of being trusted from the create-order response: a wrong or hostile `tx.to` would
 * otherwise put the account's whole token balance at risk rather than one order's worth.
 */
export function assertAllowanceHolderSpender(chain: string, spender: string): void {
  const expected = ALLOWANCE_HOLDER_BY_CHAIN[String(chain).toLowerCase()]
  if (!expected) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `refusing to approve ${spender}: no known AllowanceHolder for chain "${chain}" ` +
        `(known: ${Object.keys(ALLOWANCE_HOLDER_BY_CHAIN).join(', ')})`
    )
  }
  if (toHexAddress(spender) !== expected) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `refusing to approve ${spender} on chain "${chain}": expected the AllowanceHolder at ${expected}`
    )
  }
}

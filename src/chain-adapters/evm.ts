import { GatewaySwidgeError, ERR } from '../errors.js'
import { MAX_UINT256 } from '../allowance-holder.js'

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * USDT on Ethereum mainnet. Its non-standard `approve` reverts when changing a non-zero allowance
 * to another non-zero value, and WDK's `WalletAccountEvm.approve` refuses that case up front.
 */
const ETHEREUM_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'

export interface EvmRequiredApproval {
  token: string
  spender: string
  amount: bigint
  /**
   * Present (always `true`) when the current allowance must first be reset to 0 —
   * send `approve({ token, spender, amount: 0n })` before approving `amount`.
   */
  resetRequired?: true
}

/**
 * Detect ERC-4337 (AA) accounts.
 * Checks the `isErc4337` flag first, then falls back to constructor name.
 *
 * NOTE: In production integrations, prefer
 *   `account instanceof WalletAccountEvmErc4337`
 *   (imported from `@tetherto/wdk-wallet-evm-erc-4337`) for robustness
 *   against minified class names. The import is intentionally omitted here
 *   to keep the peer dependency optional and tests simple.
 */
function isAa(account: object): boolean {
  return (
    (account as { isErc4337?: boolean }).isErc4337 === true ||
    (account.constructor != null && account.constructor.name === 'WalletAccountEvmErc4337')
  )
}

interface EvmTx {
  to: string
  data: string
  value: string
}

interface EvmPayload {
  tx: EvmTx
  [key: string]: unknown
}

interface EvmAccount {
  getAllowance?: (token: string, spender: string) => Promise<bigint>
  sendTransaction: (txOrArray: EvmTx | EvmTx[], config?: unknown) => Promise<{ hash: string }>
  quoteSendTransaction?: (tx: EvmTx) => Promise<{ fee?: bigint; gas?: bigint }>
  [key: string]: unknown
}

export interface EvmSimulateResult {
  tx: EvmTx
  gasEstimate: bigint | null
  requiredApproval: EvmRequiredApproval | null
  valid: boolean
  reason?: string
}

export const evmAdapter = {
  family: 'evm' as const,

  /**
   * Return the approval needed before `send`, or null if none required.
   * Returns null when:
   *   - tokenAddress is falsy or the zero address (native asset), or
   *   - existing allowance already covers `amount`.
   * Sets `resetRequired` for USDT on Ethereum (`opts.chain === 'ethereum'`) when a non-zero
   * allowance is already in place, mirroring `@gobob/bob-sdk`'s reset-approval step.
   */
  async getRequiredApproval(
    account: EvmAccount,
    tokenAddress: string,
    spender: string,
    amount: bigint | string | number,
    opts: { chain?: string } = {}
  ): Promise<EvmRequiredApproval | null> {
    if (!tokenAddress || tokenAddress.toLowerCase() === ZERO) return null
    const allowance = BigInt(await account.getAllowance!(tokenAddress, spender))
    if (allowance >= BigInt(amount)) return null
    const approval = { token: tokenAddress, spender, amount: MAX_UINT256 }
    const needsReset =
      allowance !== 0n &&
      opts.chain?.toLowerCase() === 'ethereum' &&
      tokenAddress.toLowerCase() === ETHEREUM_USDT
    return needsReset ? { ...approval, resetRequired: true } : approval
  },

  /**
   * Broadcast the EVM transaction.
   * AA accounts receive `[tx]` plus `opts.aaConfig`; EOA accounts receive the tx directly.
   */
  async send(
    account: EvmAccount,
    payload: EvmPayload,
    opts: { aaConfig?: unknown } = {}
  ): Promise<{ txid: string }> {
    const tx = payload.tx
    const result = isAa(account)
      ? await account.sendTransaction([tx], opts.aaConfig)
      : await account.sendTransaction(tx)
    return { txid: result.hash }
  },

  /**
   * Dry-run the EVM transaction via `quoteSendTransaction` (estimates gas / reverts if invalid)
   * without broadcasting. Also computes required token approval if token/amount are supplied.
   *
   * Never throws on a simulation revert, nor on a failed allowance read — both come back as
   * `valid: false` with `reason`. Throws `NOT_SUPPORTED` only when the account lacks
   * `quoteSendTransaction` entirely.
   */
  async simulate(
    account: EvmAccount,
    payload: EvmPayload,
    opts: {
      token?: string
      spender?: string
      amount?: bigint | string | number
      chain?: string
    } = {}
  ): Promise<EvmSimulateResult> {
    if (typeof account.quoteSendTransaction !== 'function') {
      throw new GatewaySwidgeError(
        ERR.NOT_SUPPORTED,
        'evm account does not support quoteSendTransaction'
      )
    }
    const spender = opts.spender ?? payload.tx.to
    let requiredApproval: EvmRequiredApproval | null = null

    try {
      const { token, amount, chain } = opts
      if (token != null && amount != null) {
        requiredApproval = await this.getRequiredApproval(account, token, spender, amount, {
          chain,
        })
      }
      const result = await account.quoteSendTransaction(payload.tx)
      const gasEstimate = result.fee ?? result.gas ?? null
      return { tx: payload.tx, gasEstimate, requiredApproval, valid: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { tx: payload.tx, gasEstimate: null, requiredApproval, valid: false, reason }
    }
  },
}

const ZERO = '0x0000000000000000000000000000000000000000'

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
  [key: string]: unknown
}

export const evmAdapter = {
  family: 'evm' as const,

  /**
   * Return the approval needed before `send`, or null if none required.
   * Returns null when:
   *   - tokenAddress is falsy or the zero address (native asset), or
   *   - existing allowance already covers `amount`.
   */
  async getRequiredApproval(
    account: EvmAccount,
    tokenAddress: string,
    spender: string,
    amount: bigint | string | number
  ): Promise<{ token: string; spender: string; amount: bigint } | null> {
    if (!tokenAddress || tokenAddress.toLowerCase() === ZERO) return null
    const allowance = await account.getAllowance!(tokenAddress, spender)
    if (BigInt(allowance) >= BigInt(amount)) return null
    return { token: tokenAddress, spender, amount: BigInt(amount) }
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
}

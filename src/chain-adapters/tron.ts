import { GatewaySwidgeError, ERR } from '../errors.js'

const APPROVE_SELECTOR = 'approve(address,uint256)'
const ALLOWANCE_SELECTOR = 'allowance(address,address)'

const DEFAULT_FEE_LIMIT_SUN = 100_000_000

/** Native TRX, spelled two ways: the EVM zero address and its Base58Check form. */
const NATIVE_TOKENS = new Set([
  '0x0000000000000000000000000000000000000000',
  'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
])

/** Base58Check is case-sensitive, so match it verbatim; hex is not, so also try lowercased. */
function isNativeToken(tokenAddress: string): boolean {
  return NATIVE_TOKENS.has(tokenAddress) || NATIVE_TOKENS.has(tokenAddress.toLowerCase())
}

/** A tronweb transaction, as returned by `transactionBuilder.*`. */
export interface TronPrebuiltTx {
  txID: string
  raw_data: Record<string, unknown>
  raw_data_hex: string
  [key: string]: unknown
}

/**
 * The `TronSmartContractCall` shape accepted by `WalletAccountTron.sendTransaction`
 * (wdk-wallet-tron ≥ 1.0.0-beta.8).
 */
export interface TronApprovalCall {
  contractAddress: string
  functionSelector: typeof APPROVE_SELECTOR
  parameters: { type: string; value: string }[]
  options: { feeLimit: number }
}

export interface TronWebLike {
  transactionBuilder: {
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: Record<string, unknown>,
      parameters: unknown[],
      issuerAddress: string
    ): Promise<{ transaction?: TronPrebuiltTx }>
    triggerConstantContract(
      contractAddress: string,
      functionSelector: string,
      options: Record<string, unknown>,
      parameters: unknown[],
      issuerAddress: string
    ): Promise<{ constant_result?: string[] }>
  }
}

interface TronAccount {
  getAddress(): string | Promise<string>
  sendTransaction?: (tx: TronPrebuiltTx) => Promise<{ hash: string }>
  quoteSendTransaction?: (
    tx: TronPrebuiltTx
  ) => Promise<{ fee?: bigint | number; activationFee?: bigint | number }>
  _tronWeb?: TronWebLike
  [key: string]: unknown
}

export interface TronOpts {
  tronWeb?: TronWebLike
  tronProvider?: string
}

interface TronTx {
  to: string
  data: string
  value: string
  feeLimit?: string
}

interface TronPayload {
  tx: TronTx
  [key: string]: unknown
}

export interface TronSimulateResult {
  tx: TronTx
  feeEstimate: bigint | null
  requiredApproval: { token: string; spender: string; amount: bigint } | null
  valid: boolean
  reason?: string
}

const providerCache = new Map<string, TronWebLike>()

async function resolveTronWeb(account: TronAccount, opts: TronOpts): Promise<TronWebLike> {
  if (opts.tronWeb) return opts.tronWeb
  if (opts.tronProvider) {
    const cached = providerCache.get(opts.tronProvider)
    if (cached) return cached
    // Imported lazily: consumers that never touch Tron never load tronweb.
    const { TronWeb } = await import('tronweb')
    const built = new TronWeb({ fullHost: opts.tronProvider }) as unknown as TronWebLike
    providerCache.set(opts.tronProvider, built)
    return built
  }
  if (account && account._tronWeb) return account._tronWeb
  throw new GatewaySwidgeError(
    ERR.NOT_SUPPORTED,
    'no tron provider available: pass config.tronWeb or config.tronProvider, ' +
      'or use a WalletAccountTron connected to a provider'
  )
}

function toSun(value: string | undefined, fallback: number, field: string): number {
  if (value == null || value === '') return fallback
  let big: bigint
  try {
    big = BigInt(value)
  } catch {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `tron order tx.${field} is not an integer: ${value}`
    )
  }
  if (big < 0n) throw new GatewaySwidgeError(ERR.VALIDATION, `tron order tx.${field} is negative`)
  if (big > BigInt(Number.MAX_SAFE_INTEGER))
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `tron order tx.${field} exceeds the safe integer range`
    )
  return Number(big)
}

async function buildUnsignedTx(
  tronWeb: TronWebLike,
  owner: string,
  tx: TronTx
): Promise<TronPrebuiltTx> {
  const data = String(tx.data || '').replace(/^0x/, '')
  if (!data) throw new GatewaySwidgeError(ERR.VALIDATION, 'tron order tx.data is empty')
  const feeLimit = toSun(tx.feeLimit, DEFAULT_FEE_LIMIT_SUN, 'feeLimit')
  if (feeLimit <= 0)
    throw new GatewaySwidgeError(ERR.VALIDATION, 'tron order tx.feeLimit must be positive')
  const callValue = toSun(tx.value, 0, 'value')

  const built = await tronWeb.transactionBuilder.triggerSmartContract(
    tx.to,
    '',
    { input: data, callValue, feeLimit },
    [],
    owner
  )
  if (!built || !built.transaction) {
    throw new GatewaySwidgeError(ERR.HTTP, 'tron node returned no transaction for the order call', {
      cause: built,
    })
  }
  return built.transaction
}

export const tronAdapter = {
  family: 'tron' as const,

  async getRequiredApproval(
    account: TronAccount,
    tokenAddress: string,
    spender: string,
    amount: bigint | string | number,
    opts: TronOpts = {}
  ): Promise<{ token: string; spender: string; amount: bigint } | null> {
    if (!tokenAddress || isNativeToken(tokenAddress)) return null
    const tronWeb = await resolveTronWeb(account, opts)
    const owner = await account.getAddress()
    const res = await tronWeb.transactionBuilder.triggerConstantContract(
      tokenAddress,
      ALLOWANCE_SELECTOR,
      {},
      [
        { type: 'address', value: owner },
        { type: 'address', value: spender },
      ],
      owner
    )
    const word = res && res.constant_result && res.constant_result[0]
    if (!word) {
      throw new GatewaySwidgeError(ERR.HTTP, `allowance() returned no result for ${tokenAddress}`, {
        cause: res,
      })
    }
    const allowance = BigInt(`0x${word}`)
    if (allowance >= BigInt(amount)) return null
    return { token: tokenAddress, spender, amount: BigInt(amount) }
  },

  async send(
    account: TronAccount,
    payload: TronPayload,
    opts: TronOpts = {}
  ): Promise<{ txid: string }> {
    if (typeof account.sendTransaction !== 'function') {
      throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, 'tron account cannot send transactions')
    }
    const tronWeb = await resolveTronWeb(account, opts)
    const owner = await account.getAddress()
    const unsigned = await buildUnsignedTx(tronWeb, owner, payload.tx)
    const result = await account.sendTransaction(unsigned)
    return { txid: result.hash }
  },

  async simulate(
    account: TronAccount,
    payload: TronPayload,
    opts: TronOpts & { token?: string; spender?: string; amount?: bigint | string | number } = {}
  ): Promise<TronSimulateResult> {
    const spender = opts.spender ?? payload.tx.to
    const requiredApproval =
      opts.token != null && opts.amount != null
        ? await this.getRequiredApproval(account, opts.token, spender, opts.amount, opts)
        : null

    try {
      const tronWeb = await resolveTronWeb(account, opts)
      const owner = await account.getAddress()
      const unsigned = await buildUnsignedTx(tronWeb, owner, payload.tx)
      let feeEstimate: bigint | null = null
      if (typeof account.quoteSendTransaction === 'function') {
        const quote = await account.quoteSendTransaction(unsigned)
        feeEstimate = quote.fee != null ? BigInt(quote.fee) : null
      }
      return { tx: payload.tx, feeEstimate, requiredApproval, valid: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { tx: payload.tx, feeEstimate: null, requiredApproval, valid: false, reason }
    }
  },
}

export function buildTronApproval(
  approval: { token: string; spender: string; amount: bigint | string | number },
  opts: { feeLimit?: number } = {}
): TronApprovalCall {
  return {
    contractAddress: approval.token,
    functionSelector: APPROVE_SELECTOR,
    parameters: [
      { type: 'address', value: approval.spender },
      { type: 'uint256', value: String(approval.amount) },
    ],
    options: { feeLimit: opts.feeLimit ?? DEFAULT_FEE_LIMIT_SUN },
  }
}

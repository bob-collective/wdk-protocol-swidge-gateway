import { GatewaySwidgeError, ERR } from '../errors.js'

const APPROVE_SELECTOR = 'approve(address,uint256)'
const ALLOWANCE_SELECTOR = 'allowance(address,address)'

const DEFAULT_FEE_LIMIT_SUN = 100_000_000

/**
 * Native TRX, spelled three ways: the EVM zero address, the Tron hex form of the same
 * (the `0x41` version byte plus twenty zero bytes) and its Base58Check form.
 */
const NATIVE_TOKENS = new Set([
  '0x0000000000000000000000000000000000000000',
  '410000000000000000000000000000000000000000',
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

interface TronNodeStatus {
  result?: boolean | { result?: boolean; code?: string; message?: string }
  Error?: string
}

export interface TronWebLike {
  transactionBuilder: {
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: Record<string, unknown>,
      parameters: unknown[],
      issuerAddress: string
    ): Promise<TronNodeStatus & { transaction?: TronPrebuiltTx }>
    triggerConstantContract(
      contractAddress: string,
      functionSelector: string,
      options: Record<string, unknown>,
      parameters: unknown[],
      issuerAddress: string
    ): Promise<TronNodeStatus & { constant_result?: string[] }>
  }
}

interface TronAccount {
  getAddress(): string | Promise<string>
  sendTransaction?: (tx: TronPrebuiltTx) => Promise<{ hash: string }>
  quoteSendTransaction?: (tx: TronPrebuiltTx) => Promise<{ fee?: bigint | number }>
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

const PROVIDER_CACHE_MAX = 8
const providerCache = new Map<string, TronWebLike>()

function getCachedProvider(url: string): TronWebLike | undefined {
  const cached = providerCache.get(url)
  if (!cached) return undefined
  providerCache.delete(url)
  providerCache.set(url, cached)
  return cached
}

function cacheProvider(url: string, provider: TronWebLike): void {
  providerCache.set(url, provider)
  while (providerCache.size > PROVIDER_CACHE_MAX) {
    const oldest = providerCache.keys().next().value
    if (oldest === undefined) return
    providerCache.delete(oldest)
  }
}

async function resolveTronWeb(account: TronAccount, opts: TronOpts): Promise<TronWebLike> {
  if (opts.tronWeb) return opts.tronWeb
  if (opts.tronProvider) {
    const cached = getCachedProvider(opts.tronProvider)
    if (cached) return cached
    // Imported lazily: consumers that never touch Tron never load tronweb.
    const { TronWeb } = await import('tronweb')
    const built = new TronWeb({ fullHost: opts.tronProvider }) as unknown as TronWebLike
    cacheProvider(opts.tronProvider, built)
    return built
  }
  if (account && account._tronWeb) return account._tronWeb
  throw new GatewaySwidgeError(
    ERR.NOT_SUPPORTED,
    'no tron provider available: pass config.tronWeb or config.tronProvider, ' +
      'or use a WalletAccountTron connected to a provider. Note that those two ' +
      'options only cover building the order call and reading allowances — ' +
      'broadcasting always goes through the account, which must be connected ' +
      'to a provider of its own'
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

function assertNodeAccepted(res: TronNodeStatus | undefined, what: string): void {
  if (!res) return
  const status = res.result
  const rejected =
    status === false || (status != null && typeof status === 'object' && status.result === false)
  if (!rejected && !res.Error) return
  const message =
    (typeof status === 'object' && status != null ? status.message : undefined) ?? res.Error
  const code = typeof status === 'object' && status != null ? status.code : undefined
  const detail = [code, message]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(': ')
  throw new GatewaySwidgeError(
    ERR.HTTP,
    `tron node rejected ${what}${detail ? `: ${detail}` : ''}`,
    { cause: res }
  )
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
  assertNodeAccepted(built, 'the order call')
  if (!built || !built.transaction) {
    throw new GatewaySwidgeError(ERR.HTTP, 'tron node returned no transaction for the order call', {
      cause: built,
    })
  }
  await assertBuiltTxMatches(built.transaction, { owner, to: tx.to, data, callValue, feeLimit })
  return built.transaction
}

/** Longest transaction lifetime we accept; tronweb's own default window is 60s. */
const MAX_TX_WINDOW_MS = 10 * 60 * 1000
/** How far ahead of our own clock a node's `timestamp` may sit before we distrust it. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

interface TronRawContract {
  type?: string
  parameter?: { value?: Record<string, unknown> }
  Permission_id?: number
}

interface TronRawData {
  contract?: TronRawContract[]
  fee_limit?: number
  timestamp?: number
  expiration?: number
  data?: string
}

/**
 * Re-checks the node's built transaction against the call we asked for, before the
 * account signs its `txID`. See AGENTS.md for why tronweb's own check isn't enough.
 */
async function assertBuiltTxMatches(
  built: TronPrebuiltTx,
  expected: { owner: string; to: string; data: string; callValue: number; feeLimit: number }
): Promise<void> {
  const { utils } = await import('tronweb')
  const fail = (message: string): never => {
    throw new GatewaySwidgeError(ERR.VALIDATION, `tron node returned ${message}`, { cause: built })
  }
  const toHex = (address: unknown, field: string): string => {
    if (typeof address !== 'string' || address === '') fail(`no ${field} for the order call`)
    try {
      return utils.address.toHex(address as string).toLowerCase()
    } catch {
      return fail(`an unreadable ${field}: ${String(address)}`)
    }
  }

  if ('signature' in built) {
    fail('a transaction carrying a signature, which the account would broadcast unsigned by us')
  }

  const rawData = (built.raw_data ?? {}) as TronRawData
  const contracts = rawData.contract
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    fail(`${String(contracts?.length ?? 0)} contract calls for the order, expected exactly 1`)
  }
  const [contract] = contracts as TronRawContract[]
  if (contract.type !== 'TriggerSmartContract') {
    fail(`a ${String(contract.type)}, expected a TriggerSmartContract`)
  }
  if (rawData.data != null && rawData.data !== '') {
    fail(`a transaction carrying a memo we did not ask for: ${String(rawData.data)}`)
  }
  if (contract.Permission_id != null && Number(contract.Permission_id) !== 0) {
    fail(`a Permission_id ${String(contract.Permission_id)}, expected the owner permission (0)`)
  }

  let bound = false
  try {
    bound = utils.transaction.txCheck(built)
  } catch {
    bound = false
  }
  if (!bound) fail('a transaction whose txID and raw_data_hex do not match its raw_data')

  const value = contract.parameter?.value ?? {}
  const check = (field: string, actual: string | number, want: string | number): void => {
    if (actual !== want) fail(`${field} ${String(actual)} for the order call, expected ${want}`)
  }
  check(
    'owner_address',
    toHex(value.owner_address, 'owner_address'),
    toHex(expected.owner, 'owner')
  )
  check(
    'contract_address',
    toHex(value.contract_address, 'contract_address'),
    toHex(expected.to, 'to')
  )
  check('calldata', String(value.data ?? '').toLowerCase(), expected.data.toLowerCase())
  check('call_value', Number(value.call_value ?? 0), expected.callValue)
  check('fee_limit', Number(rawData.fee_limit ?? 0), expected.feeLimit)
  check('call_token_value', Number(value.call_token_value ?? 0), 0)
  check('token_id', Number(value.token_id ?? 0), 0)

  // Timing is the one part a node legitimately supplies, so it is bounded rather than
  // matched: a stretched expiration widens the replay window for the signed transaction.
  const now = Date.now()
  const timestamp = Number(rawData.timestamp ?? 0)
  const expiration = Number(rawData.expiration ?? 0)
  if (!(timestamp > 0)) fail('a transaction with no timestamp')
  if (timestamp > now + MAX_CLOCK_SKEW_MS) {
    fail(`a timestamp ${timestamp - now}ms ahead of local time`)
  }
  if (!(expiration > 0)) fail('a transaction with no expiration')
  if (expiration <= timestamp) fail('a transaction that expires before it was created')
  if (expiration <= now - MAX_CLOCK_SKEW_MS) {
    fail(`a transaction that expired ${now - expiration}ms ago`)
  }
  const window = expiration - timestamp
  if (window > MAX_TX_WINDOW_MS) {
    fail(`an expiration ${window}ms out, beyond the ${MAX_TX_WINDOW_MS}ms we accept`)
  }
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
    assertNodeAccepted(res, `the allowance() read on ${tokenAddress}`)
    const results = res && Array.isArray(res.constant_result) ? res.constant_result : []
    if (results.length === 0) {
      throw new GatewaySwidgeError(ERR.HTTP, `allowance() returned no result for ${tokenAddress}`, {
        cause: res,
      })
    }
    if (results.length !== 1) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `allowance() returned ${results.length} results for ${tokenAddress}, expected 1`,
        { cause: res }
      )
    }
    const [word] = results
    if (typeof word !== 'string' || !/^[0-9a-fA-F]{64}$/.test(word)) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `allowance() returned a ${String(word).length}-char result for ${tokenAddress}, expected one 32-byte uint256 word`,
        { cause: res }
      )
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
    let requiredApproval: { token: string; spender: string; amount: bigint } | null = null

    try {
      if (opts.token != null && opts.amount != null) {
        requiredApproval = await this.getRequiredApproval(
          account,
          opts.token,
          spender,
          opts.amount,
          opts
        )
      }
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

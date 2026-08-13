import { GatewaySwidgeError, ERR } from '../errors.js'

const APPROVE_SELECTOR = 'approve(address,uint256)'
const ALLOWANCE_SELECTOR = 'allowance(address,address)'

const DEFAULT_FEE_LIMIT_SUN = 100_000_000

const BROADCAST_CONFIRM_TIMEOUT_MS = 20_000
const BROADCAST_POLL_INTERVAL_MS = 1_500

/** Native TRX: the EVM zero address, its Tron hex form (`0x41` + 20 zero bytes), and Base58Check. */
const NATIVE_TOKENS = new Set([
  '0x0000000000000000000000000000000000000000',
  '410000000000000000000000000000000000000000',
  'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
])

/** Base58Check is case-sensitive, so match it verbatim; hex is not, so also try lowercased. */
function isNativeToken(tokenAddress: string): boolean {
  return NATIVE_TOKENS.has(tokenAddress) || NATIVE_TOKENS.has(tokenAddress.toLowerCase())
}

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
  trx?: {
    getTransaction(transactionID: string): Promise<unknown>
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
  confirmTimeoutMs?: number
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

/** One client per node URL; re-inserting on hit makes the eviction least-recently-used. */
const PROVIDER_CACHE_MAX = 8
const providerCache = new Map<string, TronWebLike>()

async function resolveTronWeb(account: TronAccount, opts: TronOpts): Promise<TronWebLike> {
  if (opts.tronWeb) return opts.tronWeb
  const url = opts.tronProvider
  if (url) {
    let provider = providerCache.get(url)
    if (provider) {
      providerCache.delete(url)
    } else {
      // Imported lazily: consumers that never touch Tron never load tronweb.
      const { TronWeb } = await import('tronweb')
      provider = new TronWeb({ fullHost: url }) as unknown as TronWebLike
      while (providerCache.size >= PROVIDER_CACHE_MAX) {
        providerCache.delete(providerCache.keys().next().value as string)
      }
    }
    providerCache.set(url, provider)
    return provider
  }
  if (account && account._tronWeb) return account._tronWeb
  throw new GatewaySwidgeError(
    ERR.NOT_SUPPORTED,
    'no tron provider available: pass config.tronWeb or config.tronProvider, or use a ' +
      "WalletAccountTron connected to a provider. Neither option replaces the account's " +
      'own provider, which broadcasts'
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
  const detailed = typeof status === 'object' && status !== null ? status : undefined
  if (status !== false && detailed?.result !== false && !res.Error) return
  const detail = [detailed?.code, detailed?.message ?? res.Error]
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

/** See AGENTS.md for why tronweb's own response check isn't enough on its own. */
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

  // Timing is the one part a node legitimately supplies, so bound it rather than match it:
  // a stretched expiration widens the replay window for the signed transaction.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


function resolveGetTransaction(
  account: TronAccount,
  tronWeb: TronWebLike
): (txid: string) => Promise<unknown> {
  const own = account?._tronWeb?.trx
  const trx = own && typeof own.getTransaction === 'function' ? own : tronWeb.trx
  if (!trx || typeof trx.getTransaction !== 'function') {
    throw new GatewaySwidgeError(
      ERR.NOT_SUPPORTED,
      'this tron provider exposes no trx.getTransaction, so a broadcast could not be ' +
        'confirmed: pass a real tronweb instance as config.tronWeb, or a node URL as ' +
        'config.tronProvider'
    )
  }
  return (txid) => trx.getTransaction(txid)
}

function resolveConfirmTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs == null) return BROADCAST_CONFIRM_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `config.tronConfirmTimeoutMs is ${timeoutMs}, which is not a number of milliseconds we ` +
        'can wait for: pass a finite value of at least 0, or leave it unset for the ' +
        `${BROADCAST_CONFIRM_TIMEOUT_MS}ms default`
    )
  }
  return timeoutMs
}

function normalizeTxid(txid: string): string {
  return txid.replace(/^0x/i, '').toLowerCase()
}

function readsBackAs(res: unknown, txid: string): boolean {
  const found = (res as { txID?: unknown } | null | undefined)?.txID
  return typeof found === 'string' && normalizeTxid(found) === txid
}

async function assertBroadcast(
  getTransaction: (txid: string) => Promise<unknown>,
  txid: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const res = await getTransaction(txid)
      if (readsBackAs(res, txid)) return
      last = res
    } catch (err) {
      last = err
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(BROADCAST_POLL_INTERVAL_MS, remaining))
  }
  throw new GatewaySwidgeError(
    ERR.HTTP,
    `the tron node still does not know transaction ${txid} ${timeoutMs}ms after broadcasting ` +
      'it, so the broadcast was rejected (an unactivated or unfunded sender is the usual ' +
      'cause). Check that txid on chain before sending the same transfer again',
    { cause: last }
  )
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
    const required = BigInt(amount)
    if (BigInt(`0x${word}`) >= required) return null
    return { token: tokenAddress, spender, amount: required }
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
    const getTransaction = resolveGetTransaction(account, tronWeb)
    const confirmTimeoutMs = resolveConfirmTimeout(opts.confirmTimeoutMs)
    const owner = await account.getAddress()
    const unsigned = await buildUnsignedTx(tronWeb, owner, payload.tx)
    const result = await account.sendTransaction(unsigned)
    const hash = result?.hash
    if (typeof hash !== 'string' || hash === '') {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        'the tron account returned no transaction hash for the order call, so the node ' +
          'rejected the broadcast (an unactivated or unfunded sender is the usual cause). ' +
          `The transaction we built and signed is ${unsigned.txID} — check that on chain ` +
          'before sending the same transfer again',
        { cause: result }
      )
    }
    const txid = normalizeTxid(unsigned.txID)
    if (normalizeTxid(hash) !== txid) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `the tron account broadcast returned hash ${hash}, but the transaction we built and ` +
          `signed is ${unsigned.txID}, so that hash is not ours and must not be registered. ` +
          'Check both txids on chain before sending the same transfer again',
        { cause: result }
      )
    }
    await assertBroadcast(getTransaction, txid, confirmTimeoutMs)
    return { txid }
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

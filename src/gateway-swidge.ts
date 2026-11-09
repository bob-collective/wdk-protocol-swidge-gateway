import {
  AccountRequiredError,
  SwidgeError,
  SwidgeErrorReason,
  SwidgeProtocol,
  ValueError,
} from '@tetherto/wdk-wallet/protocols'
import type {
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeStatusOptions,
  SwidgeSupportedTokensOptions,
} from '@tetherto/wdk-wallet/protocols'
import { GatewayClient } from './gateway-client.js'
import type { GatewayClientConfig } from './gateway-client.js'
import { getAdapter } from './chain-adapters/registry.js'
import { evmAdapter } from './chain-adapters/evm.js'
import { bitcoinAdapter } from './chain-adapters/bitcoin.js'
import { tronAdapter } from './chain-adapters/tron.js'
import type { TronOpts } from './chain-adapters/tron.js'
import type { EvmRequiredApproval } from './chain-adapters/evm.js'
import { chainFamily, detectVariant } from './chains.js'
import { isBtcAlias, toQuoteParams } from './map/options.js'
import type { Affiliate } from './map/options.js'
import { quoteSlippageBps, toSwidgeQuote } from './map/quote.js'
import type { GatewayQuoteV4, GatewaySwidgeQuote, WireTokenAmount } from './map/quote.js'
import { assertFeeCaps } from './fee-caps.js'
import { toSwidgeStatus } from './map/status.js'
import { toSupportedChains, toSupportedTokens } from './map/routes.js'
import { orderPayload } from './map/order.js'
import type { OrderPayload } from './map/order.js'
import type { RegisterTxV4, SwidgeSimulation } from './types.js'
import { GatewaySwidgeError, ERR } from './errors.js'
import { assertAllowanceHolderSpender } from './allowance-holder.js'

const BOB_BEARER_TOKEN = '49e52108b436492ebf03e85aa914718b' // gateway-wdk attribution key

function assertPayloadFamily(payload: OrderPayload, srcFamily: string): void {
  const family = payload.kind === 'btc' ? 'bitcoin' : payload.kind
  if (family !== srcFamily) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `create-order returned a ${payload.kind} transaction for a ${srcFamily} route`,
      { cause: payload }
    )
  }
}

const VARIANTS = ['onramp', 'offramp', 'tokenSwap'] as const
type Variant = (typeof VARIANTS)[number]

/**
 * The quote must carry exactly the requested variant: the checks read whichever variant key is
 * present, while create-order posts `quote[variant]` — two keys would let them see different
 * quotes.
 */
function assertQuoteVariant(quote: GatewayQuoteV4, variant: Variant): void {
  const present = VARIANTS.filter((v) => quote[v] != null)
  if (present.length !== 1 || present[0] !== variant || typeof quote[variant] !== 'object') {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `expected a ${variant} quote, got ${present.join(' + ') || 'none'}`,
      { cause: quote }
    )
  }
}

/**
 * The quote must be for what was asked. create-order posts it verbatim, and an onramp signs and
 * sends the quote's `inputAmount` of BTC — so a quote for another amount, recipient, refund
 * address or token pair would execute that instead, while `minAmountOut` and the fee caps (which
 * only compare the quote against itself) still pass. The amount must be echoed; the addresses are
 * compared when echoed (the onramp quote has no `refundAddress`), case-insensitively since the
 * gateway checksums EVM addresses.
 */
function assertQuoteMatchesRequest(
  quote: GatewayQuoteV4,
  variant: Variant,
  params: Record<string, string | undefined>
): void {
  const inner = quote[variant] as unknown as Record<string, unknown>
  const input = inner.inputAmount as WireTokenAmount | undefined
  const output = inner.outputAmount as WireTokenAmount | undefined
  const fail = (field: string, got: unknown, want: unknown): never => {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `quote ${field} ${got} does not match the requested ${want}`,
      { cause: quote }
    )
  }
  let amount: bigint | undefined
  try {
    amount = BigInt(input?.amount as string)
  } catch {
    // fall through
  }
  if (amount === undefined || amount !== BigInt(params.amount as string)) {
    fail('input amount', input?.amount, params.amount)
  }
  const echoes: [field: string, got: unknown, want: string | undefined][] = [
    ['recipient', inner.recipient, params.recipient],
    ['refundAddress', inner.refundAddress, params.refundAddress],
    ['source token', input?.address, params.srcToken],
    ['destination token', output?.address, params.dstToken],
  ]
  for (const [field, got, want] of echoes) {
    if (got == null || want == null) continue
    if (typeof got !== 'string' || got.toLowerCase() !== want.toLowerCase()) fail(field, got, want)
  }
}

/** Checks run on the quote before create-order, so a refused swidge leaves no orphaned order. */
interface OrderChecks {
  minAmountOut?: bigint
  caps?: SwidgeProtocolConfig
}

/** Parse an integer base-unit amount option, or throw `ValueError` naming it. */
function baseUnits(name: string, value: number | bigint | string): bigint {
  try {
    // BigInt('') is 0n — an empty string must not read as a zero amount.
    const n = typeof value === 'string' && value.trim() === '' ? -1n : BigInt(value)
    if (n >= 0n) return n
  } catch {
    // fall through
  }
  throw new ValueError(`${name} must be a non-negative integer amount in base units, got ${value}`)
}

export interface GatewaySwidgeConfig extends SwidgeProtocolConfig {
  apiUrl?: string
  bearerToken?: string
  http?: GatewayClientConfig['http']
  client?: GatewayClient
  affiliates?: Affiliate[]
  paymasterToken?: string
  slippage?: number
  feeRate?: number
  fromChain?: string
  refundAddress?: string
  tronWeb?: TronOpts['tronWeb']
  tronProvider?: string
  tronConfirmTimeoutMs?: number
  [key: string]: unknown
}

/**
 * GatewaySwidge — concrete SwidgeProtocol backed by the BOB Gateway V4 API.
 */
export class GatewaySwidge extends SwidgeProtocol {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare protected _account: any

  private _client: GatewayClient
  private _affiliates: Affiliate[] | undefined
  private _paymasterToken: string | undefined
  private _slippage: number | undefined
  private _feeRate: number | undefined
  private _fromChain: string | undefined
  private _refundAddress: string | undefined
  private _tronOpts: TronOpts
  private _spenderCache: Map<string, string>

  /**
   * Create a BOB Gateway swidge protocol instance.
   *
   * @param account - WDK account used to sign and submit source-chain transactions.
   * @param config - Gateway client, routing, fee, and chain configuration.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(account: any, config: GatewaySwidgeConfig = {}) {
    super(account, config)
    this._client =
      config.client ||
      new GatewayClient({
        apiUrl: config.apiUrl,
        bearerToken: config.bearerToken || BOB_BEARER_TOKEN,
        http: config.http,
      })
    this._affiliates = config.affiliates
    this._paymasterToken = config.paymasterToken
    this._slippage = config.slippage
    this._feeRate = config.feeRate
    this._fromChain = config.fromChain
    this._refundAddress = config.refundAddress
    this._tronOpts = {
      tronWeb: config.tronWeb,
      tronProvider: config.tronProvider,
      confirmTimeoutMs: config.tronConfirmTimeoutMs,
    }
    this._spenderCache = new Map()
  }

  /**
   * Resolve source/destination chains and families.
   */
  private _resolveChains(options: { fromChain?: string; toChain?: string | number }): {
    fromChain: string
    toChain: string
    srcFamily: string
    dstFamily: string
  } {
    const fromChain = options.fromChain || this._fromChain
    if (!fromChain) throw new Error('source chain unknown: pass config.fromChain')
    // WDK types `toChain` as `string | number`; gateway chain ids are strings.
    const toChain =
      options.toChain != null && options.toChain !== '' ? String(options.toChain) : fromChain
    return {
      fromChain,
      toChain,
      srcFamily: chainFamily(fromChain),
      dstFamily: chainFamily(toChain),
    }
  }

  /**
   * Build quote params and derived context fields shared by quoteSwidge/swidge.
   */
  private async _buildQuoteParams(options: SwidgeOptions & { fromChain?: string }): Promise<{
    params: Record<string, string | undefined>
    variant: 'onramp' | 'offramp' | 'tokenSwap'
    srcFamily: string
    affiliateApplied: boolean
    fromChain: string
  }> {
    if (options.toTokenAmount != null) {
      throw new ValueError(
        'exact-out swidges (toTokenAmount) are not supported by the BOB Gateway: pass fromTokenAmount'
      )
    }
    if (options.fromTokenAmount == null) throw new ValueError('fromTokenAmount is required')
    const fromTokenAmount = baseUnits('fromTokenAmount', options.fromTokenAmount)
    const { fromChain, toChain, srcFamily, dstFamily } = this._resolveChains(options)
    // 'BTC' resolves to the zero address, which on any other chain is that chain's native gas
    // token — so a 'BTC' toToken with toChain left to default to an EVM source would swap into ETH.
    if (isBtcAlias(options.fromToken) && srcFamily !== 'bitcoin') {
      throw new ValueError(
        `fromToken 'BTC' is native bitcoin, but the source chain is ${fromChain}`
      )
    }
    if (isBtcAlias(options.toToken) && dstFamily !== 'bitcoin') {
      throw new ValueError(
        `toToken 'BTC' is native bitcoin, but the destination chain is ${toChain}` +
          (options.toChain == null || options.toChain === ''
            ? " (toChain defaults to the source chain): pass toChain: 'bitcoin'"
            : '')
      )
    }
    const variant = detectVariant({ srcFamily, dstFamily })
    const fromAddress =
      this._account && typeof this._account.getAddress === 'function'
        ? await this._account.getAddress()
        : undefined
    const refundAddress = this._refundAddress ?? fromAddress
    // A same-chain swap pays out to the sender by default. Cross-chain routes need an explicit
    // recipient: the sender's address may be invalid on the destination (another chain family) or
    // not controlled there (an ERC-4337 account is only deployed where it was deployed).
    const sameChain = toChain.toLowerCase() === fromChain.toLowerCase()
    const recipient = options.recipient ?? (sameChain ? fromAddress : undefined)
    if (!recipient) {
      throw new ValueError(
        sameChain
          ? 'recipient is required: pass options.recipient, or use an account with getAddress()'
          : `recipient is required for cross-chain routes (${fromChain} → ${toChain})`
      )
    }
    const params = toQuoteParams(
      {
        ...options,
        fromChain,
        toChain,
        recipient,
        fromTokenAmount,
      },
      {
        fromAddress,
        refundAddress,
        defaultSlippage: this._slippage,
        affiliates: this._affiliates,
        variant,
      }
    )
    const affiliateApplied = params.affiliates !== undefined
    return { params, variant, srcFamily, affiliateApplied, fromChain }
  }

  /**
   * Request a non-binding quote for a swap, bridge, or combined route.
   *
   * @param options - Source asset, destination asset, amount, chains, and recipient.
   * @returns Quote containing expected output, price impact, and fees.
   */
  async quoteSwidge(options: SwidgeOptions): Promise<GatewaySwidgeQuote> {
    const { params, affiliateApplied } = await this._buildQuoteParams(options)
    const gw = (await this._client.getQuote(params)) as GatewayQuoteV4
    return toSwidgeQuote(gw, { affiliateApplied })
  }

  /** Fail fast — before any gateway call — when the account cannot sign on the source chain. */
  private _assertCanSign(srcFamily: string): void {
    const method = srcFamily === 'bitcoin' ? 'signTransaction' : 'sendTransaction'
    if (!this._account || typeof this._account[method] !== 'function') {
      throw new AccountRequiredError(
        `swidge() needs a full account that implements ${method}(); a read-only account can ` +
          'only quote'
      )
    }
  }

  /**
   * Quote and execute a swap, bridge, or combined route.
   *
   * @param options - Source asset, destination asset, amount, chains, and recipient.
   * @param config - Per-execution fee caps (override the instance's) and an optional paymaster
   *   token.
   * @returns Executed order ID, source transaction hash, amounts, and fees.
   */
  async swidge(
    options: SwidgeOptions,
    config: SwidgeProtocolConfig & { paymasterToken?: string } = {}
  ): Promise<SwidgeResult> {
    this._assertCanSign(this._resolveChains(options).srcFamily)
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const { quote, payload } = await this._createOrder(params, variant, srcFamily, {
      minAmountOut: this._minAmountOut(options),
      caps: this._caps(config),
    })
    // Map the result before broadcasting: a malformed quote must throw while failing is free.
    const sq = toSwidgeQuote(quote, { affiliateApplied: params.affiliates !== undefined })
    const adapter = getAdapter(srcFamily)

    let txid: string
    if (payload.kind === 'btc') {
      const { txid: id, hex } = await (adapter as typeof bitcoinAdapter).send(
        this._account,
        { ...payload },
        { feeRate: this._feeRate }
      )
      await this._registerOnramp({ onramp: { order_id: payload.orderId, bitcoin_tx_hex: hex } }, id)
      txid = id
    } else {
      // V4 has no offramp/tokenSwap register-tx: the gateway indexes the source tx from chain.
      const sent =
        payload.kind === 'tron'
          ? await (adapter as typeof tronAdapter).send(
              this._account,
              { ...payload },
              this._tronOpts
            )
          : await (adapter as typeof evmAdapter).send(
              this._account,
              { ...payload },
              {
                aaConfig: this._aaConfig(config),
              }
            )
      txid = sent.txid
    }

    return {
      id: payload.orderId,
      hash: txid,
      fees: sq.fees,
      transactions: [{ hash: txid, chain: fromChain, type: 'source' }],
      fromTokenAmount: sq.fromTokenAmount,
      toTokenAmount: sq.toTokenAmount,
      toTokenAmountMin: sq.toTokenAmountMin,
    }
  }

  /** Per-call caps override the instance's, cap by cap. */
  private _caps(config: SwidgeProtocolConfig): SwidgeProtocolConfig {
    return {
      maxNetworkFeeBps: config.maxNetworkFeeBps ?? this._config.maxNetworkFeeBps,
      maxProtocolFeeBps: config.maxProtocolFeeBps ?? this._config.maxProtocolFeeBps,
    }
  }

  private _minAmountOut(options: SwidgeOptions): bigint | undefined {
    return options.minAmountOut == null
      ? undefined
      : baseUnits('minAmountOut', options.minAmountOut)
  }

  /**
   * Quote → checks → create-order → payload, with the payload's family checked against the
   * route's. The checks run before create-order, so a refused swidge leaves no orphaned order.
   */
  private async _createOrder(
    params: Record<string, string | undefined>,
    variant: 'onramp' | 'offramp' | 'tokenSwap',
    srcFamily: string,
    checks: OrderChecks = {}
  ): Promise<{ quote: GatewayQuoteV4; payload: OrderPayload }> {
    if (!params.refundAddress) {
      throw new GatewaySwidgeError(
        ERR.VALIDATION,
        'refundAddress required: pass options.refundAddress or config.refundAddress, or use an ' +
          'account with getAddress()'
      )
    }
    const quote = (await this._client.getQuote(params)) as GatewayQuoteV4
    assertQuoteVariant(quote, variant)
    const srcChain = (quote[variant] as { srcChain?: unknown } | undefined)?.srcChain
    if (
      srcChain !== undefined &&
      String(srcChain).toLowerCase() !== params.srcChain?.toLowerCase()
    ) {
      throw new GatewaySwidgeError(
        ERR.VALIDATION,
        `quote is for source chain ${srcChain}, but the route was requested from ${params.srcChain}`
      )
    }
    assertQuoteMatchesRequest(quote, variant, params)
    if (checks.minAmountOut !== undefined) {
      // Without the echoed slippage, toTokenAmountMin would be the bare estimate — not a floor.
      if (quoteSlippageBps(quote) === null) {
        throw new GatewaySwidgeError(
          ERR.VALIDATION,
          'cannot verify minAmountOut: the quote carries no slippage to derive its minimum from',
          { cause: quote }
        )
      }
      const { toTokenAmountMin } = toSwidgeQuote(quote, { affiliateApplied: false })
      if (toTokenAmountMin < checks.minAmountOut) {
        throw new SwidgeError(
          `quote guarantees at least ${toTokenAmountMin} of the destination token after slippage, ` +
            `below minAmountOut ${checks.minAmountOut}`,
          { reason: SwidgeErrorReason.COULD_NOT_MET_THRESHOLD }
        )
      }
    }
    if (checks.caps) assertFeeCaps(quote, variant, checks.caps)
    const order = (await this._client.createOrder({ [variant]: quote[variant] })) as Record<
      string,
      unknown
    >
    const payload = orderPayload(order, variant, quote)
    assertPayloadFamily(payload, srcFamily)
    return { quote, payload }
  }

  private _aaConfig(config: { paymasterToken?: string }): unknown {
    const pm = (config && config.paymasterToken) || this._paymasterToken
    return pm ? { paymasterToken: pm } : undefined
  }

  /**
   * Hand the signed onramp tx to the gateway for broadcast, and check that the txid it reports
   * is the one we signed. A failure can follow a broadcast that did go out (e.g. a retry after a
   * lost response), so the error never claims the tx was not sent.
   */
  private async _registerOnramp(body: RegisterTxV4, txid: string): Promise<void> {
    let res: unknown
    try {
      res = await this._client.registerTx(body)
    } catch (err) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `register-tx failed for order ${body.onramp.order_id}: bitcoin transaction ${txid} may ` +
          'or may not have been broadcast — check the chain before resending',
        { status: (err as { status?: number })?.status, cause: err }
      )
    }
    const reported = (res as { onramp?: { txid?: unknown } } | null)?.onramp?.txid
    const norm = (id: string) => id.toLowerCase().replace(/^0x/, '')
    if (typeof reported !== 'string' || norm(reported) !== norm(txid)) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `register-tx reported txid ${reported} for order ${body.onramp.order_id}, expected ${txid}`,
        { cause: res }
      )
    }
  }

  /**
   * Validate a swidge short of broadcasting.
   *
   * Follows the same setup as `swidge()` up through building the payload, then calls the
   * adapter's `simulate()` instead of `send()`. The Gateway order created here is orphaned
   * (no registerTx call, no broadcast) — the gateway reconciles orphaned orders automatically.
   *
   * Returns a `SwidgeSimulation` describing the dry-run result, including validity and gas/fee
   * estimates. `broadcast` is always `false`.
   *
   * @param options - Source asset, destination asset, amount, chains, and recipient.
   * @param config - Per-call fee caps, as for `swidge()`.
   * @returns Dry-run result with route-specific validity and fee estimates.
   */
  async simulateSwidge(
    options: SwidgeOptions & { fromChain?: string },
    config: SwidgeProtocolConfig = {}
  ): Promise<SwidgeSimulation> {
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const { quote, payload } = await this._createOrder(params, variant, srcFamily, {
      minAmountOut: this._minAmountOut(options),
      caps: this._caps(config),
    })
    const adapter = getAdapter(srcFamily)
    const sq = toSwidgeQuote(quote, { affiliateApplied: params.affiliates !== undefined })
    const common = {
      variant,
      orderId: payload.orderId,
      quote: sq as unknown as Record<string, unknown>,
      broadcast: false as const,
    }

    if (payload.kind === 'btc') {
      return {
        ...common,
        onramp: await (adapter as typeof bitcoinAdapter).simulate(
          this._account,
          { ...payload },
          { feeRate: this._feeRate }
        ),
      }
    }
    const approvalOpts = {
      token: (options as { fromToken?: string }).fromToken,
      spender: payload.tx.to,
      amount: options.fromTokenAmount,
    }
    if (payload.kind === 'tron') {
      const tron = await (adapter as typeof tronAdapter).simulate(
        this._account,
        { ...payload },
        { ...this._tronOpts, ...approvalOpts }
      )
      if (tron.requiredApproval)
        assertAllowanceHolderSpender(fromChain, tron.requiredApproval.spender)
      return { ...common, tron }
    }
    const evm = await (adapter as typeof evmAdapter).simulate(
      this._account,
      { ...payload },
      { ...approvalOpts, chain: fromChain }
    )
    if (evm.requiredApproval) assertAllowanceHolderSpender(fromChain, evm.requiredApproval.spender)
    return { ...common, evm }
  }

  /**
   * Fetch current status for a Gateway order.
   *
   * @param id - Gateway order ID returned by `swidge()`.
   * @param _options - Optional WDK status query settings; currently unused.
   * @returns Mapped WDK status and route transactions.
   */
  async getSwidgeStatus(id: string, _options?: SwidgeStatusOptions): Promise<SwidgeStatusResult> {
    const order = await this._client.getOrder(id)
    return toSwidgeStatus(order as Parameters<typeof toSwidgeStatus>[0])
  }

  /**
   * Discover chains supported by current Gateway route matrix.
   *
   * @returns Supported source and destination chains.
   */
  async getSupportedChains(): Promise<SwidgeSupportedChain[]> {
    return toSupportedChains(
      (await this._client.getRoutes()) as Parameters<typeof toSupportedChains>[0]
    )
  }

  /**
   * Discover tokens supported by current Gateway route matrix.
   *
   * @param options - Optional source-chain filter.
   * @returns Supported tokens, optionally filtered by source chain.
   */
  async getSupportedTokens(
    options?: SwidgeSupportedTokensOptions
  ): Promise<SwidgeSupportedToken[]> {
    const opts = options
      ? { fromChain: options.fromChain != null ? String(options.fromChain) : undefined }
      : {}
    return toSupportedTokens(
      (await this._client.getRoutes()) as Parameters<typeof toSupportedTokens>[0],
      opts
    )
  }

  /**
   * Returns the ERC-20/TRC-20 approval the caller must grant before an offramp/tokenSwap swidge,
   * or null when none is needed (incl. all onramp routes).
   *
   * NOTE: on a cache miss this creates a Gateway order to discover the spender contract address
   * (the V4 API exposes no read-only spender lookup); results are cached per route on this
   * instance, so call it once per route, not before every swap.
   *
   * USDT on Ethereum cannot move between two non-zero allowances; when a stale non-zero allowance
   * is in place the result carries `resetRequired: true`, and the caller must first send
   * `approve({ token, spender, amount: 0n })`, then approve `amount`.
   *
   * @param options - Route and source-token amount requiring an allowance check.
   * @returns Required token approval, or `null` when current allowance is sufficient or unnecessary.
   */
  async getRequiredApproval(
    options: SwidgeOptions & {
      fromToken: string
      toToken: string
      fromTokenAmount: bigint | string | number
    }
  ): Promise<EvmRequiredApproval | null> {
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    if (variant === 'onramp') return null
    const key = `${fromChain}:${variant}:${options.fromToken}:${options.toToken}:${(options.toChain as string) || ''}`
    let spender: string
    if (this._spenderCache.has(key)) {
      spender = this._spenderCache.get(key)!
    } else {
      const { payload } = await this._createOrder(params, variant, srcFamily)
      if (payload.kind === 'btc')
        throw new Error('expected a contract-call payload for approval check')
      spender = payload.tx.to
      this._spenderCache.set(key, spender)
    }
    const approval =
      srcFamily === 'tron'
        ? await tronAdapter.getRequiredApproval(
            this._account,
            options.fromToken,
            spender,
            options.fromTokenAmount,
            this._tronOpts
          )
        : await evmAdapter.getRequiredApproval(
            this._account,
            options.fromToken,
            spender,
            options.fromTokenAmount,
            { chain: fromChain }
          )
    if (approval) assertAllowanceHolderSpender(fromChain, approval.spender)
    return approval
  }
}

export default GatewaySwidge

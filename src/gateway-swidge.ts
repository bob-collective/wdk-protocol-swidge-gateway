import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'
import type {
  SwidgeOptions,
  SwidgeQuote,
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
import { chainFamily, detectVariant } from './chains.js'
import { toQuoteParams } from './map/options.js'
import type { Affiliate } from './map/options.js'
import { toSwidgeQuote } from './map/quote.js'
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

export interface GatewaySwidgeConfig {
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
    // @ts-expect-error: GatewaySwidgeConfig has extra fields not in SwidgeProtocolConfig;
    // the base class only reads maxNetworkFeeBps / maxProtocolFeeBps which are absent here.
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
    const fromChain = (options.fromChain as string | undefined) || this._fromChain
    if (!fromChain) throw new Error('source chain unknown: pass config.fromChain')
    const toChain = (options.toChain as string | undefined) || fromChain
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
    const { fromChain, toChain, srcFamily, dstFamily } = this._resolveChains(options)
    const variant = detectVariant({ srcFamily, dstFamily })
    const fromAddress =
      this._account && typeof this._account.getAddress === 'function'
        ? await this._account.getAddress()
        : undefined
    const refundAddress = this._refundAddress ?? fromAddress
    const params = toQuoteParams(
      {
        ...options,
        fromChain,
        toChain,
        fromTokenAmount: options.fromTokenAmount ?? 0,
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
  async quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote> {
    const { params, affiliateApplied } = await this._buildQuoteParams(options)
    const gw = await this._client.getQuote(params)
    // priceImpact: wire is string, WDK type is number — cast at boundary.
    // fees: WDK SwidgeFee requires `token`; our local fees omit it — cast at boundary.
    return toSwidgeQuote(gw as Record<string, unknown>, {
      affiliateApplied,
    }) as unknown as SwidgeQuote
  }

  /**
   * Quote and execute a swap, bridge, or combined route.
   *
   * @param options - Source asset, destination asset, amount, chains, and recipient.
   * @param config - Per-execution settings, including an optional paymaster token.
   * @returns Executed order ID, source transaction hash, amounts, and fees.
   */
  async swidge(
    options: SwidgeOptions,
    config: Record<string, unknown> = {}
  ): Promise<SwidgeResult> {
    const { params, variant, srcFamily } = await this._buildQuoteParams(options)
    const { quote, payload } = await this._createOrder(params, variant, srcFamily)
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

    const sq = toSwidgeQuote(quote, { affiliateApplied: params.affiliates !== undefined })
    return {
      id: payload.orderId,
      hash: txid,
      // @ts-expect-error: LocalFee omits the `token` field required by SwidgeFee.
      fees: sq.fees,
      fromTokenAmount: sq.fromTokenAmount,
      toTokenAmount: sq.toTokenAmount,
    }
  }

  /** Quote → create-order → payload, with the payload's family checked against the route's. */
  private async _createOrder(
    params: Record<string, string | undefined>,
    variant: 'onramp' | 'offramp' | 'tokenSwap',
    srcFamily: string
  ): Promise<{ quote: Record<string, unknown>; payload: OrderPayload }> {
    if (!params.refundAddress) {
      throw new GatewaySwidgeError(
        ERR.VALIDATION,
        'refundAddress required: pass options.refundAddress or config.refundAddress, or use an ' +
          'account with getAddress()'
      )
    }
    const quote = (await this._client.getQuote(params)) as Record<string, unknown>
    const order = (await this._client.createOrder({ [variant]: quote[variant] })) as Record<
      string,
      unknown
    >
    const payload = orderPayload(order, variant, quote)
    assertPayloadFamily(payload, srcFamily)
    return { quote, payload }
  }

  private _aaConfig(config: Record<string, unknown>): unknown {
    const pm = (config && config.paymasterToken) || this._paymasterToken
    return pm ? { paymasterToken: pm } : undefined
  }

  /**
   * Hand the signed onramp tx to the gateway for broadcast, and check that the txid it reports
   * is the one we signed.
   *
   * Only a 4xx rejection (other than 408) proves the tx was not sent: `registerTx` retries 429s
   * alone, so no earlier attempt can have been processed. Anything else — a network error,
   * timeout, 5xx or a mismatched txid — leaves the broadcast state unknown, and the error says so
   * rather than inviting a resend that would pay twice.
   */
  private async _registerOnramp(body: RegisterTxV4, txid: string): Promise<void> {
    const orderId = body.onramp.order_id
    const unknown = (reason: string, opts: { status?: number; cause?: unknown }) =>
      new GatewaySwidgeError(
        ERR.BROADCAST_UNKNOWN,
        `${reason} for order ${orderId}: the bitcoin transaction ${txid} may or may not have ` +
          `been broadcast — check the chain or getSwidgeStatus('${orderId}') before resending`,
        opts
      )
    let res: unknown
    try {
      res = await this._client.registerTx(body)
    } catch (err) {
      const status = (err as { status?: unknown })?.status
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
        throw new GatewaySwidgeError(
          ERR.HTTP,
          `register-tx rejected for order ${orderId}: the signed bitcoin transaction ${txid} ` +
            `was not broadcast`,
          { status, cause: err }
        )
      }
      throw unknown('register-tx failed', {
        status: typeof status === 'number' ? status : undefined,
        cause: err,
      })
    }
    const reported = (res as { onramp?: { txid?: unknown } } | null)?.onramp?.txid
    if (typeof reported === 'string' && reported !== txid) {
      throw unknown(`register-tx reported txid ${reported}, expected ${txid},`, { cause: res })
    }
  }

  /**
   * Validate a swidge short of broadcasting.
   *
   * Follows the same setup as `swidge()` up through building the payload, then calls the
   * adapter's `simulate()` instead of `send()`. The Gateway order created here is orphaned
   * (no register-tx call, no broadcast) — the gateway reconciles orphaned orders automatically.
   *
   * Returns a `SwidgeSimulation` describing the dry-run result, including validity and gas/fee
   * estimates. `broadcast` is always `false`.
   *
   * @param options - Source asset, destination asset, amount, chains, and recipient.
   * @returns Dry-run result with route-specific validity and fee estimates.
   */
  async simulateSwidge(options: SwidgeOptions & { fromChain?: string }): Promise<SwidgeSimulation> {
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const { quote, payload } = await this._createOrder(params, variant, srcFamily)
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
      approvalOpts
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
   * @param options - Route and source-token amount requiring an allowance check.
   * @returns Required token approval, or `null` when current allowance is sufficient or unnecessary.
   */
  async getRequiredApproval(
    options: SwidgeOptions & {
      fromToken: string
      toToken: string
      fromTokenAmount: bigint | string | number
    }
  ): Promise<{ token: string; spender: string; amount: bigint } | null> {
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    if (variant === 'onramp') return null
    const key = `${variant}:${options.fromToken}:${options.toToken}:${(options.toChain as string) || ''}`
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
            options.fromTokenAmount
          )
    if (approval) assertAllowanceHolderSpender(fromChain, approval.spender)
    return approval
  }
}

export default GatewaySwidge

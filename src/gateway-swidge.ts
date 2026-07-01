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
import { chainFamily, detectVariant } from './chains.js'
import { toQuoteParams } from './map/options.js'
import type { Affiliate } from './map/options.js'
import { toSwidgeQuote } from './map/quote.js'
import { toSwidgeStatus } from './map/status.js'
import { toSupportedChains, toSupportedTokens } from './map/routes.js'
import { orderPayload } from './map/order.js'
import type { BtcOrderPayload, EvmOrderPayload } from './map/order.js'

const DEFAULT_SLIPPAGE = 0.03
const BOB_API_KEY = '49e52108b436492ebf03e85aa914718b' // gateway-wdk attribution key

export interface GatewaySwidgeConfig {
  apiUrl?: string
  apiKey?: string
  http?: GatewayClientConfig['http']
  client?: GatewayClient
  affiliates?: Affiliate[]
  paymasterToken?: string
  slippage?: number
  feeRate?: number
  fromChain?: string
  [key: string]: unknown
}

/**
 * GatewaySwidge — concrete SwidgeProtocol backed by the BOB Gateway V3 API.
 */
export class GatewaySwidge extends SwidgeProtocol {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare protected _account: any

  private _client: GatewayClient
  private _affiliates: Affiliate[] | undefined
  private _paymasterToken: string | undefined
  private _slippage: number
  private _feeRate: number | undefined
  private _fromChain: string | undefined
  private _spenderCache: Map<string, string>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(account: any, config: GatewaySwidgeConfig = {}) {
    // @ts-expect-error: GatewaySwidgeConfig has extra fields not in SwidgeProtocolConfig;
    // the base class only reads maxNetworkFeeBps / maxProtocolFeeBps which are absent here.
    super(account, config)
    this._client =
      config.client ||
      new GatewayClient({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey || BOB_API_KEY,
        http: config.http,
      })
    this._affiliates = config.affiliates
    this._paymasterToken = config.paymasterToken
    this._slippage = config.slippage ?? DEFAULT_SLIPPAGE
    this._feeRate = config.feeRate
    this._fromChain = config.fromChain
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
    const ownerAddress = variant === 'onramp' ? options.recipient : fromAddress
    const params = toQuoteParams(
      {
        ...options,
        fromChain,
        toChain,
        fromTokenAmount: options.fromTokenAmount ?? 0,
      },
      {
        fromAddress,
        ownerAddress,
        defaultSlippage: this._slippage,
        affiliates: this._affiliates,
        variant,
      }
    )
    const affiliateApplied = params.affiliates !== undefined
    return { params, variant, srcFamily, affiliateApplied, fromChain }
  }

  async quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote> {
    const { params, affiliateApplied } = await this._buildQuoteParams(options)
    const gw = await this._client.getQuote(params)
    // priceImpact: wire is string, WDK type is number — cast at boundary.
    // fees: WDK SwidgeFee requires `token`; our local fees omit it — cast at boundary.
    return toSwidgeQuote(gw as Record<string, unknown>, { affiliateApplied }) as unknown as SwidgeQuote
  }

  async swidge(options: SwidgeOptions, config: Record<string, unknown> = {}): Promise<SwidgeResult> {
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const quote = await this._client.getQuote(params)
    const order = await this._client.createOrder({ [variant]: (quote as Record<string, unknown>)[variant] })
    const payload = orderPayload(
      order as Record<string, unknown>,
      variant,
      quote as Record<string, unknown>
    )
    const adapter = getAdapter(srcFamily)

    let txid: string
    if (payload.kind === 'btc') {
      const btcPayload = payload as BtcOrderPayload
      const { txid: id, hex } = await (
        adapter as typeof import('./chain-adapters/bitcoin.js').bitcoinAdapter
      ).send(this._account, { ...btcPayload }, { feeRate: this._feeRate })
      await this._registerBestEffort({ onramp: { orderId: payload.orderId, bitcoinTxHex: hex } })
      txid = id
    } else {
      const evmPayload = payload as EvmOrderPayload
      const sent = await (adapter as typeof evmAdapter).send(
        this._account,
        { ...evmPayload },
        { aaConfig: this._aaConfig(config) }
      )
      const quoteVariant = (quote as Record<string, unknown>)[variant] as
        | Record<string, unknown>
        | undefined
      await this._registerBestEffort({
        [variant]: {
          orderId: payload.orderId,
          srcTxHash: sent.txid,
          srcChain: (quoteVariant && quoteVariant.srcChain) || fromChain,
        },
      })
      txid = sent.txid
    }

    const sq = toSwidgeQuote(quote as Record<string, unknown>, {
      affiliateApplied: params.affiliates !== undefined,
    })
    return {
      id: payload.orderId,
      hash: txid,
      // @ts-expect-error: LocalFee omits the `token` field required by SwidgeFee.
      fees: sq.fees,
      fromTokenAmount: sq.fromTokenAmount,
      toTokenAmount: sq.toTokenAmount,
    }
  }

  private _aaConfig(config: Record<string, unknown>): unknown {
    const pm = (config && config.paymasterToken) || this._paymasterToken
    return pm ? { paymasterToken: pm } : undefined
  }

  /**
   * Fire-and-forget register-tx: a registration failure must not propagate.
   * The gateway reconciles orders from on-chain state.
   */
  private async _registerBestEffort(body: unknown): Promise<void> {
    try {
      await this._client.registerTx(body)
    } catch {
      /* best-effort; order reconciles later */
    }
  }

  async getSwidgeStatus(id: string, _options?: SwidgeStatusOptions): Promise<SwidgeStatusResult> {
    const order = await this._client.getOrder(id)
    return toSwidgeStatus(order as Parameters<typeof toSwidgeStatus>[0])
  }

  async getSupportedChains(): Promise<SwidgeSupportedChain[]> {
    return toSupportedChains(
      (await this._client.getRoutes()) as Parameters<typeof toSupportedChains>[0]
    )
  }

  async getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]> {
    const opts = options ? { fromChain: options.fromChain != null ? String(options.fromChain) : undefined } : {}
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
   * (the V3 API exposes no read-only spender lookup); results are cached per route on this
   * instance, so call it once per route, not before every swap.
   */
  async getRequiredApproval(
    options: SwidgeOptions & { fromToken: string; toToken: string; fromTokenAmount: bigint | string | number }
  ): Promise<{ token: string; spender: string; amount: bigint } | null> {
    const { params, variant } = await this._buildQuoteParams(options)
    if (variant === 'onramp') return null
    const key = `${variant}:${options.fromToken}:${options.toToken}:${(options.toChain as string) || ''}`
    let spender: string
    if (this._spenderCache.has(key)) {
      spender = this._spenderCache.get(key)!
    } else {
      const quote = await this._client.getQuote(params)
      const order = await this._client.createOrder({
        [variant]: (quote as Record<string, unknown>)[variant],
      })
      const payload = orderPayload(
        order as Record<string, unknown>,
        variant,
        quote as Record<string, unknown>
      )
      if (payload.kind !== 'evm') throw new Error('expected evm payload for approval check')
      spender = payload.tx.to
      this._spenderCache.set(key, spender)
    }
    return evmAdapter.getRequiredApproval(
      this._account,
      options.fromToken,
      spender,
      options.fromTokenAmount
    )
  }
}

export default GatewaySwidge

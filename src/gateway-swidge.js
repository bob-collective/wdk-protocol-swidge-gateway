'use strict'

import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'
import { GatewayClient } from './gateway-client.js'
import { getAdapter } from './chain-adapters/registry.js'
import { evmAdapter } from './chain-adapters/evm.js'
import { chainFamily, detectVariant } from './chains.js'
import { toQuoteParams } from './map/options.js'
import { toSwidgeQuote } from './map/quote.js'
import { toSwidgeStatus } from './map/status.js'
import { toSupportedChains, toSupportedTokens } from './map/routes.js'
import { orderPayload } from './map/order.js'

const DEFAULT_SLIPPAGE = 0.03
const BOB_API_KEY = '49e52108b436492ebf03e85aa914718b' // gateway-wdk attribution key

/**
 * GatewaySwidge — concrete SwidgeProtocol backed by the BOB Gateway V3 API.
 *
 * @extends {SwidgeProtocol}
 */
export class GatewaySwidge extends SwidgeProtocol {
  /**
   * @param {object} account  Wallet account (BTC or EVM).
   * @param {object} [config]
   * @param {string} [config.apiUrl]        Gateway API base URL.
   * @param {string} [config.apiKey]        API key (defaults to BOB attribution key).
   * @param {object} [config.http]          Injectable HTTP transport (for tests).
   * @param {object} [config.client]        Fully-formed GatewayClient override (for tests).
   * @param {Array}  [config.affiliates]    Affiliate list `[{address, bps}]`.
   * @param {string} [config.paymasterToken] ERC-20 paymaster token for AA accounts.
   * @param {number} [config.slippage]      Default slippage (default 0.03 = 3 %).
   * @param {number} [config.feeRate]       BTC fee rate (sat/vByte).
   * @param {string} [config.fromChain]     Source chain id (required when not in SwidgeOptions).
   */
  constructor (account, config = {}) {
    super(account, config)
    this._client = config.client || new GatewayClient({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey || BOB_API_KEY,
      http: config.http
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
   * @param {object} options
   * @returns {{ fromChain: string, toChain: string, srcFamily: string, dstFamily: string }}
   */
  _resolveChains (options) {
    const fromChain = options.fromChain || this._fromChain
    if (!fromChain) throw new Error('source chain unknown: pass config.fromChain')
    const toChain = options.toChain || fromChain
    return {
      fromChain,
      toChain,
      srcFamily: chainFamily(fromChain),
      dstFamily: chainFamily(toChain)
    }
  }

  /**
   * Build quote params and derived context fields shared by quoteSwidge/swidge.
   * @param {object} options
   * @returns {Promise<{ params: object, variant: string, srcFamily: string, affiliateApplied: boolean, fromChain: string }>}
   */
  async _buildQuoteParams (options) {
    const { fromChain, toChain, srcFamily, dstFamily } = this._resolveChains(options)
    const variant = detectVariant({ srcFamily, dstFamily })
    const fromAddress = this._account && typeof this._account.getAddress === 'function'
      ? await this._account.getAddress()
      : undefined
    const ownerAddress = variant === 'onramp' ? options.recipient : fromAddress
    const params = toQuoteParams({ ...options, fromChain, toChain }, {
      fromAddress,
      ownerAddress,
      defaultSlippage: this._slippage,
      affiliates: this._affiliates,
      variant
    })
    const affiliateApplied = params.affiliates !== undefined
    return { params, variant, srcFamily, affiliateApplied, fromChain }
  }

  /**
   * @param {object} options SwidgeOptions
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeQuote>}
   */
  async quoteSwidge (options) {
    const { params, affiliateApplied } = await this._buildQuoteParams(options)
    const gw = await this._client.getQuote(params)
    return toSwidgeQuote(gw, { affiliateApplied })
  }

  /**
   * @param {object} options SwidgeOptions
   * @param {object} [config] Provider-specific execution config.
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeResult>}
   */
  async swidge (options, config = {}) {
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const quote = await this._client.getQuote(params)
    const order = await this._client.createOrder({ [variant]: quote[variant] })
    const payload = orderPayload(order, variant, quote)
    const adapter = getAdapter(srcFamily)

    let txid
    if (payload.kind === 'btc') {
      const { txid: id, hex } = await adapter.send(this._account, payload, { feeRate: this._feeRate })
      await this._registerBestEffort({ onramp: { orderId: payload.orderId, bitcoinTxHex: hex } })
      txid = id
    } else {
      const sent = await adapter.send(this._account, payload, { aaConfig: this._aaConfig(config) })
      await this._registerBestEffort({ [variant]: { orderId: payload.orderId, srcTxHash: sent.txid, srcChain: fromChain } })
      txid = sent.txid
    }

    const sq = toSwidgeQuote(quote, { affiliateApplied: params.affiliates !== undefined })
    return {
      id: payload.orderId,
      hash: txid,
      fees: sq.fees,
      fromTokenAmount: sq.fromTokenAmount,
      toTokenAmount: sq.toTokenAmount
    }
  }

  /**
   * @param {object} config
   * @returns {object|undefined}
   */
  _aaConfig (config) {
    const pm = (config && config.paymasterToken) || this._paymasterToken
    return pm ? { paymasterToken: pm } : undefined
  }

  /**
   * Fire-and-forget register-tx: a registration failure must not propagate.
   * The gateway reconciles orders from on-chain state.
   * @param {object} body
   */
  async _registerBestEffort (body) {
    try { await this._client.registerTx(body) } catch (_) { /* best-effort; order reconciles later */ }
  }

  /**
   * @param {string} id  Order id returned by swidge().
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeStatusResult>}
   */
  async getSwidgeStatus (id) {
    const order = await this._client.getOrder(id)
    return toSwidgeStatus(order)
  }

  /** @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedChain[]>} */
  async getSupportedChains () {
    return toSupportedChains(await this._client.getRoutes())
  }

  /**
   * @param {object} [options]
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedToken[]>}
   */
  async getSupportedTokens (options) {
    return toSupportedTokens(await this._client.getRoutes(), options || {})
  }

  /**
   * Returns the ERC-20/TRC-20 approval the caller must grant before an offramp/tokenSwap swidge,
   * or null when none is needed (incl. all onramp routes).
   *
   * NOTE: on a cache miss this creates a Gateway order to discover the spender contract address
   * (the V3 API exposes no read-only spender lookup); results are cached per route on this
   * instance, so call it once per route, not before every swap.
   *
   * @param {object} options SwidgeOptions
   * @returns {Promise<{token: string, spender: string, amount: bigint}|null>}
   */
  async getRequiredApproval (options) {
    const { params, variant } = await this._buildQuoteParams(options)
    if (variant === 'onramp') return null
    const key = `${variant}:${options.fromToken}:${options.toToken}:${options.toChain || ''}`
    let spender
    if (this._spenderCache.has(key)) {
      spender = this._spenderCache.get(key)
    } else {
      const quote = await this._client.getQuote(params)
      const order = await this._client.createOrder({ [variant]: quote[variant] })
      const payload = orderPayload(order, variant, quote)
      spender = payload.tx.to
      this._spenderCache.set(key, spender)
    }
    return evmAdapter.getRequiredApproval(this._account, options.fromToken, spender, options.fromTokenAmount)
  }
}

export default GatewaySwidge

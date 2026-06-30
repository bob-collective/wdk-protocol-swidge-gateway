'use strict'
import { createDefaultTransport } from './http.js'
import { GatewaySwidgeError, ERR } from './errors.js'

const DEFAULT_API = 'https://gateway-api-mainnet.gobob.xyz'

// Transient errors that are safe to retry — mirrors gateway-cli's swap.ts retry patterns.
const TRANSIENT = [/TRM screening/i, /429/, /Too Many Requests/i, /rate limit/i, /not yet propagated/i, /BTC propagation/i, /timeout/i, /ECONNRESET/i, /ETIMEDOUT/i]

/**
 * Returns true if the error is likely transient and the request can be retried.
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransient (err) {
  if (err && (err.status === 429 || err.status === 503)) return true
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT.some(re => re.test(msg))
}

/** @param {number} ms @returns {Promise<void>} */
function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

export class GatewayClient {
  /** @param {{ apiUrl?: string, apiKey?: string, http?: import('./http.js').HttpTransport, maxRetries?: number }} [config] */
  constructor (config = {}) {
    this._base = (config.apiUrl || DEFAULT_API).replace(/\/$/, '')
    this._apiKey = config.apiKey
    this._http = config.http || createDefaultTransport()
    this._maxRetries = config.maxRetries ?? 3
  }

  _headers () { return this._apiKey ? { authorization: `Bearer ${this._apiKey}` } : {} }

  async _call (method, path, { query, body } = {}) {
    let attempt = 0
    for (;;) {
      attempt++
      let status, resBody
      try {
        const res = await this._http.request(method, `${this._base}${path}`, { query, body, headers: this._headers() })
        status = res.status
        resBody = res.body
      } catch (err) {
        // Network-level error (ECONNRESET, ETIMEDOUT, etc.)
        if (attempt <= this._maxRetries && isTransient(err)) {
          await sleep(200 * attempt)
          continue
        }
        throw err
      }
      if (status >= 200 && status < 300) return resBody
      const msg = (resBody && resBody.message) || `HTTP ${status} for ${method} ${path}`
      const gwErr = new GatewaySwidgeError(ERR.HTTP, msg, { status, cause: resBody })
      // Transient HTTP errors (429, 503, TRM screening, etc.) are retried.
      // NOTE: retrying POST /v3/create-order on a transient error assumes the error occurred
      // before the order was created (the common case for 429/connect/timeout). A duplicate
      // order would be an unfulfilled orphan — consistent with how the gateway-cli retries
      // the whole flow.
      if (attempt <= this._maxRetries && isTransient(gwErr)) {
        await sleep(200 * attempt)
        continue
      }
      throw gwErr
    }
  }

  getQuote (params) { return this._call('GET', '/v3/get-quote', { query: params }) }
  createOrder (quote) { return this._call('POST', '/v3/create-order', { body: quote }) }
  registerTx (body) { return this._call('PATCH', '/v3/register-tx', { body }) }
  getOrder (id) { return this._call('GET', `/v3/get-order/${id}`) }
  getOrders (addr, params) { return this._call('GET', `/v3/get-orders/${addr}`, { query: params }) }
  getRoutes () { return this._call('GET', '/v3/get-routes') }
  getMaxSpendable (addr) { return this._call('GET', `/v3/get-max-spendable/${addr}`) }
}

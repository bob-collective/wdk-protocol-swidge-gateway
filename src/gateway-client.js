'use strict'
import { createDefaultTransport } from './http.js'
import { GatewaySwidgeError, ERR } from './errors.js'

const DEFAULT_API = 'https://gateway-api-mainnet.gobob.xyz'

export class GatewayClient {
  /** @param {{ apiUrl?: string, apiKey?: string, http?: import('./http.js').HttpTransport }} [config] */
  constructor (config = {}) {
    this._base = (config.apiUrl || DEFAULT_API).replace(/\/$/, '')
    this._apiKey = config.apiKey
    this._http = config.http || createDefaultTransport()
  }

  _headers () { return this._apiKey ? { authorization: `Bearer ${this._apiKey}` } : {} }

  async _call (method, path, { query, body } = {}) {
    const { status, body: resBody } = await this._http.request(method, `${this._base}${path}`, { query, body, headers: this._headers() })
    if (status < 200 || status >= 300) {
      const msg = (resBody && resBody.message) || `HTTP ${status} for ${method} ${path}`
      throw new GatewaySwidgeError(ERR.HTTP, msg, { status, cause: resBody })
    }
    return resBody
  }

  getQuote (params) { return this._call('GET', '/v3/get-quote', { query: params }) }
  createOrder (quote) { return this._call('POST', '/v3/create-order', { body: quote }) }
  registerTx (body) { return this._call('PATCH', '/v3/register-tx', { body }) }
  getOrder (id) { return this._call('GET', `/v3/get-order/${id}`) }
  getOrders (addr, params) { return this._call('GET', `/v3/get-orders/${addr}`, { query: params }) }
  getRoutes () { return this._call('GET', '/v3/get-routes') }
  getMaxSpendable (addr) { return this._call('GET', `/v3/get-max-spendable/${addr}`) }
}

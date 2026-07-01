import { createDefaultTransport } from './http.js'
import type { HttpTransport } from './http.js'
import { GatewaySwidgeError, ERR } from './errors.js'

const DEFAULT_API = 'https://gateway-api-mainnet.gobob.xyz'

// Transient errors that are safe to retry — mirrors gateway-cli's swap.ts retry patterns.
const TRANSIENT = [
  /TRM screening/i,
  /429/,
  /Too Many Requests/i,
  /rate limit/i,
  /not yet propagated/i,
  /BTC propagation/i,
  /timeout/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
]

function isTransient(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status
    if (status === 429 || status === 503) return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT.some((re) => re.test(msg))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface GatewayClientConfig {
  apiUrl?: string
  apiKey?: string
  http?: HttpTransport
  maxRetries?: number
}

export class GatewayClient {
  private _base: string
  private _apiKey: string | undefined
  private _http: HttpTransport
  private _maxRetries: number

  constructor(config: GatewayClientConfig = {}) {
    this._base = (config.apiUrl || DEFAULT_API).replace(/\/$/, '')
    this._apiKey = config.apiKey
    this._http = config.http || createDefaultTransport()
    this._maxRetries = config.maxRetries ?? 3
  }

  private _headers(): Record<string, string> {
    return this._apiKey ? { authorization: `Bearer ${this._apiKey}` } : {}
  }

  private async _call(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {}
  ): Promise<unknown> {
    const { query, body } = opts
    let attempt = 0
    for (;;) {
      attempt++
      let status: number, resBody: unknown
      try {
        const res = await this._http.request(method, `${this._base}${path}`, {
          query,
          body,
          headers: this._headers(),
        })
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
      const msg =
        (resBody && typeof resBody === 'object' && 'message' in resBody
          ? String((resBody as { message: unknown }).message)
          : null) || `HTTP ${status} for ${method} ${path}`
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

  getQuote(params: Record<string, string | undefined>): Promise<unknown> {
    return this._call('GET', '/v3/get-quote', { query: params })
  }
  createOrder(quote: unknown): Promise<unknown> {
    return this._call('POST', '/v3/create-order', { body: quote })
  }
  registerTx(body: unknown): Promise<unknown> {
    return this._call('PATCH', '/v3/register-tx', { body })
  }
  getOrder(id: string): Promise<unknown> {
    return this._call('GET', `/v3/get-order/${id}`)
  }
  getOrders(addr: string, params?: Record<string, string | undefined>): Promise<unknown> {
    return this._call('GET', `/v3/get-orders/${addr}`, { query: params })
  }
  getRoutes(): Promise<unknown> {
    return this._call('GET', '/v3/get-routes')
  }
  getMaxSpendable(addr: string): Promise<unknown> {
    return this._call('GET', `/v3/get-max-spendable/${addr}`)
  }
}

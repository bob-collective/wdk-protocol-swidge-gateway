import { ValueError } from '@tetherto/wdk-wallet/protocols'
import { createDefaultTransport } from './http.js'
import type { HttpTransport } from './http.js'
import { GatewaySwidgeError, ERR } from './errors.js'

const DEFAULT_API = 'https://gateway-api-mainnet.gobob.xyz'

/** Hosts a plain-`http:` `apiUrl` may name without opting in: local mock gateways. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Refuses an `apiUrl` that is not `https:`, except on loopback or when opted in. Over plain HTTP a
 * network attacker could swap the onramp's BTC deposit address in the create-order response, and
 * that address cannot be pinned.
 */
function assertSecureApiUrl(apiUrl: string, allowInsecure: boolean): void {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new ValueError('apiUrl is not a valid URL')
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && (allowInsecure || LOOPBACK.has(url.hostname))) return
  throw new ValueError(
    `apiUrl must be https: (plain http: only on localhost, or with allowInsecureApiUrl), got ` +
      `${url.protocol}//${url.host}`
  )
}

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

/**
 * Pull a readable message out of an error body. The V4 API answers `{ code, error, details? }`
 * (`GatewayErrorV4`); `message` is kept for proxies and older error shapes.
 */
function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const { code, error, message } = body as { code?: unknown; error?: unknown; message?: unknown }
  const text = typeof error === 'string' ? error : typeof message === 'string' ? message : null
  if (text && typeof code === 'string') return `${code}: ${text}`
  return text || (typeof code === 'string' ? code : null)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Configuration of a `GatewayClient`. */
export interface GatewayClientConfig {
  /** Gateway API base URL (default: `https://gateway-api-mainnet.gobob.xyz`). */
  apiUrl?: string
  /** Bearer token sent as `authorization` on every request (default: none). */
  bearerToken?: string
  /** HTTP transport (default: one built on the global `fetch`). */
  http?: HttpTransport
  /** Retries of a transient failure per request, with linear backoff (default: 3). */
  maxRetries?: number
  /**
   * Limit on each request, response body included, in milliseconds (default: 30000). A request
   * that runs over is aborted and retried as transient. Ignored when `http` is set.
   */
  timeoutMs?: number
  /**
   * Accept a plain-`http:` `apiUrl` on a host other than `localhost`/`127.0.0.1`/`[::1]`, for
   * test setups (default: false). Never set it against a real gateway: over plain HTTP a network
   * attacker can replace the onramp's BTC deposit address.
   */
  allowInsecureApiUrl?: boolean
}

/**
 * HTTP client for the BOB Gateway V4 REST API. Request and response bodies are the gateway's
 * wire format, passed through unmapped.
 */
export class GatewayClient {
  private _base: string
  private _bearerToken: string | undefined
  private _http: HttpTransport
  private _maxRetries: number

  /**
   * Creates a gateway client.
   *
   * @param [config] - The client configuration.
   * @throws {ValueError} If `config.apiUrl` is not a URL, or not `https:` — plain `http:` is
   *   accepted only on `localhost`, `127.0.0.1` and `[::1]`, or with `allowInsecureApiUrl`.
   * @throws {ValueError} If `config.timeoutMs` is not a positive safe integer.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if `config.http` is unset and the runtime has no
   *   global `fetch`.
   */
  constructor(config: GatewayClientConfig = {}) {
    const apiUrl = config.apiUrl || DEFAULT_API
    assertSecureApiUrl(apiUrl, config.allowInsecureApiUrl === true)
    const { timeoutMs } = config
    if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs > 0))
      throw new ValueError(`timeoutMs must be a positive integer, got ${timeoutMs}`)
    this._base = apiUrl.replace(/\/$/, '')
    this._bearerToken = config.bearerToken
    this._http = config.http || createDefaultTransport({ timeoutMs })
    this._maxRetries = config.maxRetries ?? 3
  }

  private _headers(): Record<string, string> {
    return this._bearerToken ? { authorization: `Bearer ${this._bearerToken}` } : {}
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
      const msg = errorMessage(resBody) || `HTTP ${status} for ${method} ${path}`
      const gwErr = new GatewaySwidgeError(ERR.HTTP, msg, { status, cause: resBody })
      // Transient HTTP errors (429, 503, TRM screening, etc.) are retried.
      // NOTE: retrying POST /v4/create-order on a transient error assumes the error occurred
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

  /**
   * Requests a quote (`GET /v4/get-quote`).
   *
   * @param params - The query parameters; undefined values are left out.
   * @returns The quote, keyed by its variant (`onramp`, `offramp` or `tokenSwap`).
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  getQuote(params: Record<string, string | undefined>): Promise<unknown> {
    return this._call('GET', '/v4/get-quote', { query: params })
  }

  /**
   * Creates an order from a quote (`POST /v4/create-order`).
   *
   * @param quote - The quote, keyed by its variant.
   * @returns The order: its id and, per variant, the deposit address or the transaction to sign.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  createOrder(quote: unknown): Promise<unknown> {
    return this._call('POST', '/v4/create-order', { body: quote })
  }

  /**
   * Hands an onramp's signed Bitcoin transaction to the gateway, which broadcasts it
   * (`PATCH /v4/register-tx`).
   *
   * @param body - `{ onramp: { order_id, bitcoin_tx_hex } }`.
   * @returns The registration result, carrying the broadcast txid.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  registerTx(body: unknown): Promise<unknown> {
    return this._call('PATCH', '/v4/register-tx', { body })
  }

  /**
   * Returns an order (`GET /v4/get-order/{id}`).
   *
   * @param id - The order id.
   * @returns The order, with its status and source/destination legs.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  getOrder(id: string): Promise<unknown> {
    return this._call('GET', `/v4/get-order/${id}`)
  }

  /**
   * Returns the orders of an address (`GET /v4/get-orders/{addr}`).
   *
   * @param addr - The address the orders were placed from.
   * @param [params] - The query parameters; undefined values are left out.
   * @returns The address's orders.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  getOrders(addr: string, params?: Record<string, string | undefined>): Promise<unknown> {
    return this._call('GET', `/v4/get-orders/${addr}`, { query: params })
  }

  /**
   * Returns the routes the gateway supports (`GET /v4/get-routes`).
   *
   * @returns The routes, one per source chain/token and destination chain/token pair.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  getRoutes(): Promise<unknown> {
    return this._call('GET', '/v4/get-routes')
  }

  /**
   * Returns the most BTC an address can send in an onramp, after fees
   * (`GET /v4/get-max-spendable/{addr}`).
   *
   * @param addr - The Bitcoin address.
   * @returns The maximum spendable amount.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway answers with a non-2xx
   *   status, after retrying transient ones (429, 503, rate limits, screening delays).
   * @throws {Error} If the transport fails with a non-transient error, or a transient one past
   *   `maxRetries`; the transport's own error is rethrown.
   */
  getMaxSpendable(addr: string): Promise<unknown> {
    return this._call('GET', `/v4/get-max-spendable/${addr}`)
  }
}

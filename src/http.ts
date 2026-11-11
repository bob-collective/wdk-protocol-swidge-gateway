import { GatewaySwidgeError, ERR } from './errors.js'

/** HTTP transport the gateway client sends its requests through. */
export interface HttpTransport {
  /**
   * Sends a request with a JSON body and returns the status and parsed JSON body.
   *
   * @param method - The HTTP method.
   * @param url - The request URL.
   * @param [opts] - The query parameters (undefined values left out), JSON body and headers.
   * @returns The response status and its JSON-parsed body (`null` when empty or not JSON).
   */
  request(
    method: string,
    url: string,
    opts?: {
      query?: Record<string, string | undefined>
      body?: unknown
      headers?: Record<string, string>
    }
  ): Promise<{ status: number; body: unknown }>
}

/** `url` with any `user:password@` dropped, so an error message never carries it. */
function withoutCredentials(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.href
  } catch {
    return '(unparseable url)'
  }
}

/** Default limit on one gateway request, response body included, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Builds the default transport on `fetch`. Each request, body included, must finish within
 * `timeoutMs`, or it is aborted and fails with a `GATEWAY_HTTP_ERROR` the gateway client retries
 * as transient.
 *
 * @param [deps] - The `fetch` to use (default: the global one) and the per-request timeout in
 *   milliseconds (default: `DEFAULT_TIMEOUT_MS`).
 * @returns The transport.
 * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if no `fetch` is passed and the runtime has none.
 */
export function createDefaultTransport(
  deps: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}
): HttpTransport {
  const fetchFn = deps.fetch || globalThis.fetch
  if (!fetchFn)
    throw new GatewaySwidgeError(
      ERR.NOT_SUPPORTED,
      'No fetch available; pass config.http for this runtime'
    )
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(
    method: string,
    url: string,
    opts: Parameters<HttpTransport['request']>[2] & {},
    signal: AbortSignal
  ): Promise<{ status: number; body: unknown }> {
    const { query, body, headers } = opts
    let full = url
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
      if (qs) full += (url.includes('?') ? '&' : '?') + qs
    }
    const res = await fetchFn(full, {
      method,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await res.text().catch(() => '')
    let parsed: unknown = null
    try {
      if (text) parsed = JSON.parse(text)
    } catch {
      /* non-JSON body → null */
    }
    return { status: res.status, body: parsed }
  }

  return {
    async request(method, url, opts = {}) {
      // The abort cancels the request; the race returns on time even if `fetch` ignores it.
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(
            new GatewaySwidgeError(
              ERR.HTTP,
              `gateway request timeout: no response to ${method} ${withoutCredentials(url)} ` +
                `within ${timeoutMs}ms`
            )
          )
        }, timeoutMs)
      })
      try {
        return await Promise.race([send(method, url, opts, controller.signal), timeout])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export interface HttpTransport {
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

export function createDefaultTransport(deps: { fetch?: typeof globalThis.fetch } = {}): HttpTransport {
  const fetchFn = deps.fetch || globalThis.fetch
  if (!fetchFn) throw new Error('No fetch available; pass config.http for this runtime')
  return {
    async request(method, url, opts = {}) {
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
      })
      const text = await res.text().catch(() => '')
      let parsed: unknown = null
      try {
        if (text) parsed = JSON.parse(text)
      } catch {
        /* non-JSON body → null */
      }
      return { status: res.status, body: parsed }
    },
  }
}

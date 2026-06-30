'use strict'

/**
 * @typedef {Object} HttpTransport
 * @property {(method: string, url: string, opts?: { query?: Record<string,string|undefined>, body?: unknown, headers?: Record<string,string> }) => Promise<{ status: number, body: unknown }>} request
 */

/** @param {{ fetch?: typeof globalThis.fetch }} [deps] @returns {HttpTransport} */
export function createDefaultTransport (deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch
  if (!fetchFn) throw new Error('No fetch available; pass config.http for this runtime')
  return {
    async request (method, url, opts = {}) {
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
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const text = await res.text().catch(() => '')
      return { status: res.status, body: text ? JSON.parse(text) : null }
    }
  }
}

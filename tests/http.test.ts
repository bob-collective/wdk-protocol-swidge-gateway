import { describe, test, expect, vi } from 'vitest'
import { createDefaultTransport } from '../src/http.js'

describe('createDefaultTransport', () => {
  test('request builds query string and parses JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }))
    const t = createDefaultTransport({ fetch: fetchMock as unknown as typeof fetch })
    const res = await t.request('GET', 'https://api/x', { query: { a: '1', b: undefined } })
    expect(fetchMock).toHaveBeenCalledWith('https://api/x?a=1', expect.objectContaining({ method: 'GET' }))
    expect(res).toEqual({ status: 200, body: { ok: true } })
  })

  test('throws a clear error when no fetch is available', () => {
    const g = globalThis.fetch
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).fetch = undefined
      expect(() => createDefaultTransport({ fetch: undefined })).toThrow(/no fetch available/i)
    } finally {
      globalThis.fetch = g
    }
  })
})

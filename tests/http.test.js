/* eslint-env jest */
import { createDefaultTransport } from '../src/http.js'
import { jest } from '@jest/globals'

test('request builds query string and parses JSON', async () => {
  const fetchMock = jest.fn(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) }))
  const t = createDefaultTransport({ fetch: fetchMock })
  const res = await t.request('GET', 'https://api/x', { query: { a: '1', b: undefined } })
  expect(fetchMock).toHaveBeenCalledWith('https://api/x?a=1', expect.objectContaining({ method: 'GET' }))
  expect(res).toEqual({ status: 200, body: { ok: true } })
})

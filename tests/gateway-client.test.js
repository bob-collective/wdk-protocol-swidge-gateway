/* eslint-env jest */
import { GatewayClient } from '../src/gateway-client.js'
import { jest } from '@jest/globals'

const transport = (impl) => ({ request: jest.fn(impl) })

test('getQuote hits /v3/get-quote with bearer + query', async () => {
  const t = transport(async () => ({ status: 200, body: { onramp: {} } }))
  const c = new GatewayClient({ apiUrl: 'https://api', apiKey: 'k'.repeat(32), http: t })
  await c.getQuote({ srcChain: 'bitcoin', amount: '1000' })
  expect(t.request).toHaveBeenCalledWith('GET', 'https://api/v3/get-quote',
    expect.objectContaining({
      query: expect.objectContaining({ srcChain: 'bitcoin', amount: '1000' }),
      headers: { authorization: 'Bearer ' + 'k'.repeat(32) }
    }))
})

test('non-transient error (400) throws GatewaySwidgeError immediately without retry', async () => {
  const t = transport(async () => ({ status: 400, body: { message: 'bad request' } }))
  const c = new GatewayClient({ apiUrl: 'https://api', http: t })
  await expect(c.getRoutes()).rejects.toMatchObject({ code: 'GATEWAY_HTTP_ERROR', status: 400 })
  expect(t.request).toHaveBeenCalledTimes(1)
})

test('transient error (429) is retried up to maxRetries then resolves on success', async () => {
  let calls = 0
  const t = transport(async () => {
    calls++
    if (calls < 3) return { status: 429, body: { message: 'rate limited' } }
    return { status: 200, body: { routes: [] } }
  })
  const c = new GatewayClient({ apiUrl: 'https://api', http: t, maxRetries: 3 })
  // Patch sleep to avoid real delays in tests
  const result = await c.getRoutes()
  expect(result).toEqual({ routes: [] })
  expect(t.request).toHaveBeenCalledTimes(3)
})

test('transient error exhausts retries and rethrows', async () => {
  const t = transport(async () => ({ status: 429, body: { message: 'rate limited' } }))
  const c = new GatewayClient({ apiUrl: 'https://api', http: t, maxRetries: 2 })
  await expect(c.getRoutes()).rejects.toMatchObject({ code: 'GATEWAY_HTTP_ERROR', status: 429 })
  // 1 initial + 2 retries = 3 total calls
  expect(t.request).toHaveBeenCalledTimes(3)
})

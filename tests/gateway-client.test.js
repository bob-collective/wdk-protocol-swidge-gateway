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

test('non-2xx throws GatewaySwidgeError with status', async () => {
  const t = transport(async () => ({ status: 429, body: { message: 'rate' } }))
  const c = new GatewayClient({ apiUrl: 'https://api', http: t })
  await expect(c.getRoutes()).rejects.toMatchObject({ code: 'GATEWAY_HTTP_ERROR', status: 429 })
})

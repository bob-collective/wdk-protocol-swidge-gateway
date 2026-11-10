import { beforeEach, describe, test, expect, vi } from 'vitest'
import { ERR, GatewayClient, GatewaySwidge } from '../src/index.js'
import { BOB_BEARER_TOKEN, gatewayError } from './helpers.js'

const request = vi.fn()
const fetchMock = vi.fn()

const API = 'https://dummy-api.url'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GatewayClient', () => {
  test('getQuote sends the query and the bearer token, and returns the body', async () => {
    request.mockResolvedValue({ status: 200, body: { onramp: {} } })
    const client = new GatewayClient({
      apiUrl: API,
      bearerToken: 'dummy-bearer-token',
      http: { request },
    })

    const body = await client.getQuote({ srcChain: 'bitcoin', amount: '1000' })

    expect(request).toHaveBeenCalledWith('GET', `${API}/v4/get-quote`, {
      query: { srcChain: 'bitcoin', amount: '1000' },
      body: undefined,
      headers: { authorization: 'Bearer dummy-bearer-token' },
    })
    expect(body).toEqual({ onramp: {} })
  })

  test('a non-transient error (400) throws at once, without a retry', async () => {
    request.mockResolvedValue({ status: 400, body: { message: 'bad request' } })
    const client = new GatewayClient({ apiUrl: API, http: { request } })

    await expect(client.getRoutes()).rejects.toMatchObject({
      ...gatewayError(ERR.HTTP, 'bad request'),
      status: 400,
    })
    expect(request.mock.calls).toEqual([
      ['GET', `${API}/v4/get-routes`, { query: undefined, body: undefined, headers: {} }],
    ])
  })

  test('a V4 error body surfaces its code and message', async () => {
    request.mockResolvedValue({
      status: 400,
      body: { code: 'MISSING_REFUND_ADDRESS', error: 'refundAddress is required' },
    })
    const client = new GatewayClient({ apiUrl: API, http: { request } })

    await expect(client.createOrder({ onramp: {} })).rejects.toMatchObject({
      ...gatewayError(ERR.HTTP, 'MISSING_REFUND_ADDRESS: refundAddress is required'),
      status: 400,
    })
    expect(request).toHaveBeenCalledWith('POST', `${API}/v4/create-order`, {
      query: undefined,
      body: { onramp: {} },
      headers: {},
    })
  })

  test('a transient error (429) is retried until it succeeds', async () => {
    request
      .mockResolvedValueOnce({ status: 429, body: { message: 'rate limited' } })
      .mockResolvedValueOnce({ status: 429, body: { message: 'rate limited' } })
      .mockResolvedValueOnce({ status: 200, body: { routes: [] } })
    const client = new GatewayClient({ apiUrl: API, http: { request }, maxRetries: 3 })

    const body = await client.getRoutes()

    expect(body).toEqual({ routes: [] })
    expect(request).toHaveBeenCalledTimes(3)
  })

  test('a transient error that outlasts maxRetries is rethrown', async () => {
    request.mockResolvedValue({ status: 429, body: { message: 'rate limited' } })
    const client = new GatewayClient({ apiUrl: API, http: { request }, maxRetries: 2 })

    await expect(client.getRoutes()).rejects.toMatchObject({
      ...gatewayError(ERR.HTTP, 'rate limited'),
      status: 429,
    })
    // 1 initial + 2 retries
    expect(request).toHaveBeenCalledTimes(3)
  })
})

describe('GatewayClient: the default fetch transport', () => {
  test('builds the query string, dropping unset values, and parses the JSON body', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => '{"ok":true}' })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GatewayClient({ apiUrl: API })

    const body = await client.getQuote({ a: '1', b: undefined })

    expect(fetchMock).toHaveBeenCalledWith(`${API}/v4/get-quote?a=1`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      body: undefined,
    })
    expect(body).toEqual({ ok: true })
  })

  test('sends a JSON body with the bearer token', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => '{}' })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GatewayClient({ apiUrl: API, bearerToken: 'dummy-bearer-token' })

    await client.createOrder({ onramp: { inputAmount: { amount: '50000' } } })

    expect(fetchMock).toHaveBeenCalledWith(`${API}/v4/create-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dummy-bearer-token' },
      body: '{"onramp":{"inputAmount":{"amount":"50000"}}}',
    })
  })

  test('throws a clear error when the runtime has no fetch', () => {
    vi.stubGlobal('fetch', undefined)

    let thrown: unknown
    try {
      new GatewayClient()
    } catch (err) {
      thrown = err
    }

    expect(thrown).toMatchObject(
      gatewayError(ERR.NOT_SUPPORTED, 'No fetch available; pass config.http for this runtime')
    )
  })

  // The Bare runtime has no global fetch: an injected transport must be all GatewaySwidge needs.
  test('GatewaySwidge works with no global fetch when given config.http', async () => {
    vi.stubGlobal('fetch', undefined)
    request.mockResolvedValue({ status: 200, body: [] })
    const sw = new GatewaySwidge(undefined, { fromChain: 'base', http: { request } })

    const chains = await sw.getSupportedChains()

    expect(request).toHaveBeenCalledWith(
      'GET',
      'https://gateway-api-mainnet.gobob.xyz/v4/get-routes',
      {
        query: undefined,
        body: undefined,
        headers: { authorization: `Bearer ${BOB_BEARER_TOKEN}` },
      }
    )
    expect(chains).toEqual([])
  })
})

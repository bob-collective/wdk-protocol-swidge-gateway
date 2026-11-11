import { beforeEach, describe, test, expect, vi } from 'vitest'
import { ERR, GatewayClient, GatewaySwidge, ValueError } from '../src/index.js'
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
    })
  })

  /** A fetch that never answers; it rejects on abort only when `honourAbort` is set. */
  function hangingFetch(honourAbort: boolean) {
    return (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        if (honourAbort)
          init.signal.addEventListener('abort', () =>
            reject(new Error('This operation was aborted'))
          )
      })
  }

  test.each([
    ['aborts a request that runs over timeoutMs', true],
    ['times out even when fetch ignores the abort', false],
  ])('%s', async (_label, honourAbort) => {
    fetchMock.mockImplementation(hangingFetch(honourAbort))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GatewayClient({ apiUrl: API, timeoutMs: 20, maxRetries: 0 })

    await expect(client.getRoutes()).rejects.toMatchObject(
      gatewayError(
        ERR.HTTP,
        `gateway request timeout: no response to GET ${API}/v4/get-routes within 20ms`
      )
    )
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  test('a timeout error does not echo credentials in the apiUrl', async () => {
    fetchMock.mockImplementation(hangingFetch(true))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GatewayClient({
      apiUrl: 'https://user:secret@dummy-api.url',
      timeoutMs: 20,
      maxRetries: 0,
    })

    await expect(client.getRoutes()).rejects.toMatchObject(
      gatewayError(
        ERR.HTTP,
        `gateway request timeout: no response to GET ${API}/v4/get-routes within 20ms`
      )
    )
  })

  test('a timed-out request is retried as transient', async () => {
    fetchMock
      .mockImplementationOnce(hangingFetch(true))
      .mockResolvedValueOnce({ status: 200, text: async () => '{"routes":[]}' })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GatewayClient({ apiUrl: API, timeoutMs: 20, maxRetries: 1 })

    const body = await client.getRoutes()

    expect(body).toEqual({ routes: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses timeoutMs %s',
    (timeoutMs) => {
      vi.stubGlobal('fetch', fetchMock)

      expect(() => new GatewayClient({ apiUrl: API, timeoutMs })).toThrow(
        new ValueError(`timeoutMs must be a positive integer, got ${timeoutMs}`)
      )
    }
  )

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

describe('GatewayClient: apiUrl must be https', () => {
  test.each([
    'http://localhost:8080',
    'http://127.0.0.1',
    'http://[::1]:3000/',
    'https://gateway-api-mainnet.gobob.xyz',
  ])('accepts %s', async (apiUrl) => {
    request.mockResolvedValue({ status: 200, body: [] })
    const client = new GatewayClient({ apiUrl, http: { request } })

    await client.getRoutes()

    expect(request.mock.calls[0][1]).toBe(`${apiUrl.replace(/\/$/, '')}/v4/get-routes`)
  })

  test('refuses plain http on a non-loopback host', () => {
    expect(() => new GatewayClient({ apiUrl: 'http://gateway.test', http: { request } })).toThrow(
      new ValueError(
        'apiUrl must be https: (plain http: only on localhost, or with allowInsecureApiUrl), got ' +
          'http://gateway.test'
      )
    )
  })

  test('accepts plain http on a non-loopback host with allowInsecureApiUrl', () => {
    expect(
      () =>
        new GatewayClient({
          apiUrl: 'http://gateway.test',
          allowInsecureApiUrl: true,
          http: { request },
        })
    ).not.toThrow()
  })

  test('refuses a scheme other than http(s), even with allowInsecureApiUrl', () => {
    expect(
      () =>
        new GatewayClient({
          apiUrl: 'ftp://gateway.test',
          allowInsecureApiUrl: true,
          http: { request },
        })
    ).toThrow(
      new ValueError(
        'apiUrl must be https: (plain http: only on localhost, or with allowInsecureApiUrl), got ' +
          'ftp://gateway.test'
      )
    )
  })

  test('refuses an apiUrl that is not a URL', () => {
    expect(() => new GatewayClient({ apiUrl: 'gateway.test', http: { request } })).toThrow(
      new ValueError('apiUrl is not a valid URL')
    )
  })

  test('GatewaySwidge applies the same check to config.apiUrl', () => {
    expect(
      () => new GatewaySwidge(undefined, { apiUrl: 'http://gateway.test', http: { request } })
    ).toThrow(
      new ValueError(
        'apiUrl must be https: (plain http: only on localhost, or with allowInsecureApiUrl), got ' +
          'http://gateway.test'
      )
    )
    expect(
      () =>
        new GatewaySwidge(undefined, {
          apiUrl: 'http://gateway.test',
          allowInsecureApiUrl: true,
          http: { request },
        })
    ).not.toThrow()
  })
})

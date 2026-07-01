import { describe, test, expect, vi } from 'vitest'
// @ts-expect-error: examples are plain JS files
import { run as onrampBase } from '../examples/onramp-btc-to-usdt-base.js'
// @ts-expect-error: examples are plain JS files
import { run as quoteAndStatus } from '../examples/quote-and-status.js'

function makeMockHttp() {
  return {
    request: vi.fn(async (_method: string, url: string) => {
      if (url.includes('get-quote')) {
        return {
          status: 200,
          body: {
            onramp: {
              inputAmount: { amount: '100000' },
              outputAmount: { amount: '99000' },
              feeBreakdown: {},
            },
          },
        }
      }
      if (url.includes('create-order')) {
        return {
          status: 200,
          body: { onramp: { orderId: 'o1', address: 'bc1q', inputAmount: { amount: '100000' } } },
        }
      }
      if (url.includes('register-tx')) {
        return { status: 200, body: {} }
      }
      if (url.includes('get-order')) {
        return { status: 200, body: { status: { Success: { received_tokens: [] } } } }
      }
      return { status: 200, body: {} }
    }),
  }
}

const btcAccount = {
  getAddress: async () => 'bc1q',
  signTransaction: async () => ({ toHex: () => 'hex', getId: () => 'tid' }),
}

describe('examples smoke', () => {
  test('onramp example runs against a mock and returns order id', async () => {
    const http = makeMockHttp()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (onrampBase as any)({ account: btcAccount, http })
    expect(res.id).toBe('o1')
  })

  test('quote-and-status example returns quote and status', async () => {
    const http = makeMockHttp()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (quoteAndStatus as any)({ account: btcAccount, http })
    expect(res.quote.fromTokenAmount).toBe(100000n)
    expect(res.status.status).toBe('completed')
  })
})

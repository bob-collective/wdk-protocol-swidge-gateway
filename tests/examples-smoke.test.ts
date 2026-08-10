import { describe, test, expect, vi } from 'vitest'
import { Transaction } from 'bitcoinjs-lib'
import { run as onrampBase } from '../examples/onramp-btc-to-usdt-base.js'
import { run as quoteAndStatus } from '../examples/quote-and-status.js'
import { run as offrampTron } from '../examples/offramp-usdt-tron-to-btc.js'

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
          body: { onramp: { order_id: 'o1', address: 'bc1q', inputAmount: { amount: '100000' } } },
        }
      }
      if (url.includes('register-tx')) {
        return { status: 200, body: {} }
      }
      if (url.includes('get-order')) {
        return { status: 200, body: { status: { success: { received_tokens: [] } } } }
      }
      return { status: 200, body: {} }
    }),
  }
}

const _btcTx = (() => {
  const tx = new Transaction()
  tx.addInput(Buffer.alloc(32, 0), 0)
  return tx
})()
const btcAccount = {
  getAddress: async () => 'bc1q',
  signTransaction: async () => _btcTx.toHex(),
}

function makeTronHttp() {
  return {
    request: vi.fn(async (_method: string, url: string) => {
      if (url.includes('get-quote')) {
        return {
          status: 200,
          body: {
            offramp: {
              inputAmount: { amount: '1000000' },
              outputAmount: { amount: '950' },
              srcChain: 'tron',
              feeBreakdown: {},
            },
          },
        }
      }
      if (url.includes('create-order')) {
        return {
          status: 200,
          body: {
            offramp: {
              order_id: 'tron-1',
              tx: {
                type: 'tron',
                to: 'TRegistry',
                data: '0xfeed',
                value: '0',
                feeLimit: '100000000',
              },
            },
          },
        }
      }
      return { status: 200, body: {} }
    }),
  }
}

function makeTronAccount() {
  return {
    getAddress: async () => 'TSender',
    sendTransaction: vi.fn(async (_tx: unknown) => ({ hash: 'a1b2c3' })),
    _tronWeb: {
      transactionBuilder: {
        triggerSmartContract: vi.fn(async () => ({
          transaction: { txID: 'abc', raw_data: {}, raw_data_hex: '0a' },
        })),
        triggerConstantContract: vi.fn(async () => ({ constant_result: ['0'.repeat(64)] })),
      },
    },
  }
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

  test('tron offramp example approves the TRC-20 allowance, then swidges', async () => {
    const http = makeTronHttp()
    const account = makeTronAccount()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (offrampTron as any)({ account, http })
    expect(res.id).toBe('tron-1')
    expect(res.hash).toBe('a1b2c3')
    // Two sends: the approve() call descriptor, then the pre-built order call.
    expect(account.sendTransaction).toHaveBeenCalledTimes(2)
    expect(account.sendTransaction.mock.calls[0][0]).toMatchObject({
      functionSelector: 'approve(address,uint256)',
      parameters: [
        { type: 'address', value: 'TRegistry' },
        { type: 'uint256', value: '1000000' },
      ],
    })
    expect(account.sendTransaction.mock.calls[1][0]).toMatchObject({ txID: 'abc' })
  })
})

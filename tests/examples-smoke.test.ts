// The examples/ scripts run end-to-end against a mocked gateway transport.
import { beforeEach, describe, test, expect, vi } from 'vitest'
import { run as onrampBase } from '../examples/onramp-btc-to-usdt-base.js'
import { run as quoteAndStatus } from '../examples/quote-and-status.js'
import { run as offrampTron } from '../examples/offramp-usdt-tron-to-btc.js'
import { EXAMPLE_TXID, EXAMPLE_TX_HEX } from './fixtures/bitcoin.js'
import { DEPOSIT_ADDRESS } from './fixtures/gateway.js'
import { OWNER, REGISTRY, TRON_EXEC, TRON_EXEC_HEX, USDT, buildTronTx } from './fixtures/tron.js'

const request = vi.fn()
const http = { request }

const MAX_UINT256 = 2n ** 256n - 1n

beforeEach(() => {
  vi.resetAllMocks()
})

describe('BTC examples', () => {
  class DummyBtcAccount {
    async getAddress() {
      return 'bc1qsender'
    }
    async signTransaction() {
      return EXAMPLE_TX_HEX
    }
  }

  beforeEach(() => {
    request.mockImplementation(async (_method: string, url: string) => {
      if (url.endsWith('/v4/get-quote')) {
        return {
          status: 200,
          body: {
            onramp: {
              inputAmount: { amount: '100000', chain: 'bitcoin' },
              outputAmount: { amount: '99000', chain: 'base' },
            },
          },
        }
      }
      if (url.endsWith('/v4/create-order')) {
        return { status: 200, body: { onramp: { order_id: 'o1', address: DEPOSIT_ADDRESS } } }
      }
      if (url.endsWith('/v4/register-tx')) {
        return { status: 200, body: { onramp: { txid: EXAMPLE_TXID } } }
      }
      return { status: 200, body: { status: { success: { received_tokens: [] } } } }
    })
  })

  test('the onramp example swidges and returns the order', async () => {
    const result = await onrampBase({ account: new DummyBtcAccount(), http })

    expect(result).toEqual({
      id: 'o1',
      hash: EXAMPLE_TXID,
      fees: [],
      transactions: [{ hash: EXAMPLE_TXID, chain: 'bitcoin', type: 'source' }],
      fromTokenAmount: 100_000n,
      toTokenAmount: 99_000n,
      toTokenAmountMin: 99_000n,
    })
  })

  test('the quote-and-status example returns the quote and the order status', async () => {
    const result = await quoteAndStatus({ account: new DummyBtcAccount(), http })

    expect(result).toEqual({
      quote: {
        fromTokenAmount: 100_000n,
        toTokenAmount: 99_000n,
        toTokenAmountMin: 99_000n,
        fees: [],
        affiliateApplied: false,
      },
      status: { status: 'completed', transactions: [] },
    })
  })
})

describe('Tron offramp example', () => {
  const ORDER_TX = buildTronTx({ data: TRON_EXEC_HEX, feeLimit: 100_000_000 })

  /** Logs what the example does, in order. The allowance appears only once approve() is sent. */
  class DummyTronAccount {
    log: string[] = []
    approved = false
    sendTransaction = vi.fn(async (tx: { functionSelector?: string; txID?: string }) => {
      if (tx.functionSelector === 'approve(address,uint256)') {
        this.log.push('approve')
        this.approved = true
        return { hash: 'dummy-approve-hash' }
      }
      this.log.push('send order')
      return { hash: tx.txID as string }
    })
    _tronWeb = {
      transactionBuilder: {
        triggerSmartContract: async (
          to: string,
          _selector: string,
          options: { input: string; callValue: number; feeLimit: number },
          _parameters: unknown[],
          owner: string
        ) => ({
          transaction: buildTronTx({
            to,
            owner,
            data: options.input,
            callValue: options.callValue,
            feeLimit: options.feeLimit,
          }),
        }),
        triggerConstantContract: async () => {
          this.log.push('read allowance')
          return {
            constant_result: [(this.approved ? MAX_UINT256 : 0n).toString(16).padStart(64, '0')],
          }
        },
      },
      trx: { getTransaction: async (txid: string) => ({ txID: txid }) },
    }
    async getAddress() {
      return OWNER
    }
  }

  beforeEach(() => {
    request.mockImplementation(async (_method: string, url: string) => {
      if (url.endsWith('/v4/get-quote')) {
        return {
          status: 200,
          body: {
            offramp: {
              inputAmount: { amount: '1000000', chain: 'tron' },
              outputAmount: { amount: '950', chain: 'bitcoin' },
              srcChain: 'tron',
            },
          },
        }
      }
      return {
        status: 200,
        body: {
          offramp: {
            order_id: 'tron-1',
            tx: {
              type: 'tron',
              to: REGISTRY,
              data: TRON_EXEC,
              value: '0',
              chain: 'tron',
              feeLimit: '100000000',
            },
          },
        },
      }
    })
  })

  test('approves the TRC-20 allowance, waits until it reads back, then swidges', async () => {
    const account = new DummyTronAccount()

    const result = await offrampTron({ account, http })

    expect(account.log).toEqual(['read allowance', 'approve', 'read allowance', 'send order'])
    expect(account.sendTransaction.mock.calls).toEqual([
      [
        {
          contractAddress: USDT,
          functionSelector: 'approve(address,uint256)',
          parameters: [
            { type: 'address', value: REGISTRY },
            { type: 'uint256', value: MAX_UINT256.toString() },
          ],
          options: { feeLimit: 100_000_000 },
        },
      ],
      [ORDER_TX],
    ])
    expect(result).toEqual({
      id: 'tron-1',
      hash: ORDER_TX.txID,
      fees: [],
      transactions: [{ hash: ORDER_TX.txID, chain: 'tron', type: 'source' }],
      fromTokenAmount: 1_000_000n,
      toTokenAmount: 950n,
      toTokenAmountMin: 950n,
    })
  })
})

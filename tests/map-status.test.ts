import { describe, test, expect } from 'vitest'
import { toSwidgeStatus } from '../src/map/status.js'
import type { GatewayOrderInfoV3 } from '../src/types.js'

const make = (
  status: GatewayOrderInfoV3['status'],
  extra: Partial<GatewayOrderInfoV3> = {}
): GatewayOrderInfoV3 => ({ id: 'test', timestamp: 0, status, ...extra })

const SRC = { chain: 'bitcoin', token: '0x00', amount: '33624', txHash: 'd70f' }
const transfer = (txHash: string) => ({
  token: '0xA0b8',
  amount: '24901436',
  chain: 'ethereum',
  txHash,
})

describe('toSwidgeStatus', () => {
  test('maps the 4 gateway states', () => {
    expect(toSwidgeStatus(make({ success: { received_tokens: [] } })).status).toBe('completed')
    expect(toSwidgeStatus(make({ refunded: { refunded_tokens: [] } })).status).toBe('refunded')
    expect(toSwidgeStatus(make({ failed: { refund_tx: null } })).status).toBe('failed')
    expect(toSwidgeStatus(make({ failed: { refund_tx: { hash: '0x1' } } })).status).toBe(
      'refund-pending'
    )
    expect(toSwidgeStatus(make({ inProgress: { refund_tx: { hash: '0x1' } } })).status).toBe(
      'refund-pending'
    )
    expect(toSwidgeStatus(make({ inProgress: {} })).status).toBe('pending')
  })

  test('completed: source tx from srcInfo, destination txs from received_tokens', () => {
    expect(
      toSwidgeStatus(make({ success: { received_tokens: [transfer('0xddfa')] } }, { srcInfo: SRC }))
    ).toEqual({
      status: 'completed',
      transactions: [
        { hash: 'd70f', chain: 'bitcoin', type: 'source' },
        { hash: '0xddfa', chain: 'ethereum', type: 'destination' },
      ],
    })
  })

  test('refunded: refund txs from refunded_tokens', () => {
    expect(
      toSwidgeStatus(
        make({ refunded: { refunded_tokens: [transfer('0xrefund')] } }, { srcInfo: SRC })
      )
    ).toEqual({
      status: 'refunded',
      transactions: [
        { hash: 'd70f', chain: 'bitcoin', type: 'source' },
        { hash: '0xrefund', chain: 'ethereum', type: 'refund' },
      ],
    })
  })

  test('pending: source tx not yet indexed → no transactions', () => {
    expect(toSwidgeStatus(make({ inProgress: {} }, { srcInfo: { ...SRC, txHash: null } }))).toEqual(
      { status: 'pending', transactions: [] }
    )
  })

  test('pending: falls back to a legacy pending_btc_payment for the source tx', () => {
    expect(
      toSwidgeStatus(make({ inProgress: { pending_btc_payment: { txid: 'abc', amount: '1' } } }))
    ).toEqual({
      status: 'pending',
      transactions: [{ hash: 'abc', chain: 'bitcoin', type: 'source' }],
    })
  })
})

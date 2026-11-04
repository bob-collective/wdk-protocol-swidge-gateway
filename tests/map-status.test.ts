import { describe, test, expect } from 'vitest'
import { toSwidgeStatus } from '../src/map/status.js'
import type { GatewayOrderInfoV3 } from '../src/types.js'

describe('toSwidgeStatus', () => {
  test('maps the 4 gateway states', () => {
    const make = (status: GatewayOrderInfoV3['status']): GatewayOrderInfoV3 => ({
      id: 'test',
      timestamp: 0,
      status,
    })
    expect(toSwidgeStatus(make({ success: { received_tokens: [] } })).status).toBe('completed')
    expect(toSwidgeStatus(make({ refunded: { refunded_tokens: [] } })).status).toBe('refunded')
    expect(toSwidgeStatus(make({ failed: { refund_tx: null } })).status).toBe('failed')
    expect(toSwidgeStatus(make({ failed: { refund_tx: { hash: '0x1' } } })).status).toBe('refund-pending')
    expect(toSwidgeStatus(make({ inProgress: { refund_tx: { hash: '0x1' } } })).status).toBe('refund-pending')
    const p = toSwidgeStatus(make({ inProgress: { pending_btc_payment: { txid: 'abc', amount: '1' } } }))
    expect(p.status).toBe('pending')
    expect(p.transactions![0]).toMatchObject({ hash: 'abc', type: 'source' })
  })
})

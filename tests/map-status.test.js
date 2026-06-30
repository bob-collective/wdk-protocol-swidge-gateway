/* eslint-env jest */
'use strict'

import { toSwidgeStatus } from '../src/map/status.js'

test('maps the 4 gateway states', () => {
  expect(toSwidgeStatus({ status: { Success: { received_tokens: [] } } }).status).toBe('completed')
  expect(toSwidgeStatus({ status: { Refunded: { refunded_tokens: [] } } }).status).toBe('refunded')
  expect(toSwidgeStatus({ status: { Failed: { refund_tx: null } } }).status).toBe('failed')
  expect(toSwidgeStatus({ status: { Failed: { refund_tx: { hash: '0x1' } } } }).status).toBe('refund-pending')
  expect(toSwidgeStatus({ status: { InProgress: { refund_tx: { hash: '0x1' } } } }).status).toBe('refund-pending')
  const p = toSwidgeStatus({ status: { InProgress: { pending_btc_payment: { txid: 'abc', amount: '1' } } } })
  expect(p.status).toBe('pending')
  expect(p.transactions[0]).toMatchObject({ hash: 'abc', type: 'source' })
})

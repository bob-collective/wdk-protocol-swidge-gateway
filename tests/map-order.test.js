/* eslint-env jest */
'use strict'

import { orderPayload } from '../src/map/order.js'
import { GatewaySwidgeError, ERR } from '../src/errors.js'

test('onramp: extracts orderId, address, and amount from quote', () => {
  const order = { onramp: { orderId: 'o1', address: 'bc1q' } }
  const quote = { onramp: { inputAmount: { amount: '100000' } } }
  expect(orderPayload(order, 'onramp', quote)).toEqual({
    orderId: 'o1',
    kind: 'btc',
    address: 'bc1q',
    amount: 100000n
  })
})

test('offramp: extracts orderId and tx fields', () => {
  const order = { offramp: { orderId: 'o2', tx: { to: '0xto', data: '0xdata', value: '0' } } }
  expect(orderPayload(order, 'offramp')).toEqual({
    orderId: 'o2',
    kind: 'evm',
    tx: { to: '0xto', data: '0xdata', value: '0' }
  })
})

test('tokenSwap: extracts orderId and tx fields', () => {
  const order = { tokenSwap: { orderId: 'o3', tx: { to: '0xto2', data: '0xdata2', value: '1' } } }
  expect(orderPayload(order, 'tokenSwap')).toEqual({
    orderId: 'o3',
    kind: 'evm',
    tx: { to: '0xto2', data: '0xdata2', value: '1' }
  })
})

test('throws GatewaySwidgeError when orderId is missing', () => {
  const order = { onramp: { address: 'bc1q' } }
  const quote = { onramp: { inputAmount: { amount: '100000' } } }
  expect(() => orderPayload(order, 'onramp', quote)).toThrow(GatewaySwidgeError)
  expect(() => orderPayload(order, 'onramp', quote)).toThrow(
    expect.objectContaining({ code: ERR.HTTP })
  )
})

test('throws GatewaySwidgeError when variant key is absent', () => {
  const order = {}
  expect(() => orderPayload(order, 'offramp')).toThrow(GatewaySwidgeError)
  expect(() => orderPayload(order, 'offramp')).toThrow(
    expect.objectContaining({ code: ERR.HTTP })
  )
})

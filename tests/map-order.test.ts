import { describe, test, expect } from 'vitest'
import { orderPayload } from '../src/map/order.js'
import { GatewaySwidgeError, ERR } from '../src/errors.js'

describe('orderPayload', () => {
  test('onramp: extracts orderId, address, and amount from quote', () => {
    const order = { onramp: { order_id: 'o1', address: 'bc1q' } }
    const quote = { onramp: { inputAmount: { amount: '100000' } } }
    expect(orderPayload(order, 'onramp', quote)).toEqual({
      orderId: 'o1',
      kind: 'btc',
      address: 'bc1q',
      amount: 100000n,
    })
  })

  test('offramp: extracts orderId and tx fields', () => {
    const order = { offramp: { order_id: 'o2', tx: { to: '0xto', data: '0xdata', value: '0' } } }
    expect(orderPayload(order, 'offramp')).toEqual({
      orderId: 'o2',
      kind: 'evm',
      tx: { to: '0xto', data: '0xdata', value: '0' },
    })
  })

  test('tokenSwap: extracts orderId and tx fields', () => {
    const order = {
      tokenSwap: { order_id: 'o3', tx: { to: '0xto2', data: '0xdata2', value: '1' } },
    }
    expect(orderPayload(order, 'tokenSwap')).toEqual({
      orderId: 'o3',
      kind: 'evm',
      tx: { to: '0xto2', data: '0xdata2', value: '1' },
    })
  })

  test('offramp: an explicit evm tx type still maps to kind evm', () => {
    const order = {
      offramp: { order_id: 'o4', tx: { type: 'evm', to: '0xto', data: '0xdata', value: '0' } },
    }
    expect(orderPayload(order, 'offramp')).toEqual({
      orderId: 'o4',
      kind: 'evm',
      tx: { to: '0xto', data: '0xdata', value: '0' },
    })
  })

  test('offramp: tron tx type carries the base58 target and feeLimit', () => {
    const order = {
      offramp: {
        order_id: 'o5',
        tx: {
          type: 'tron',
          to: 'TRegistry',
          data: '0xdata',
          value: '0',
          chain: 'tron',
          feeLimit: '100000000',
        },
      },
    }
    expect(orderPayload(order, 'offramp')).toEqual({
      orderId: 'o5',
      kind: 'tron',
      tx: { to: 'TRegistry', data: '0xdata', value: '0', feeLimit: '100000000' },
    })
  })

  test('rejects an unknown tx type instead of mis-signing it as evm', () => {
    const order = {
      offramp: { order_id: 'o6', tx: { type: 'solana', to: 'Sol', data: '', value: '0' } },
    }
    expect(() => orderPayload(order, 'offramp')).toThrow(
      expect.objectContaining({ code: ERR.NOT_SUPPORTED })
    )
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
})

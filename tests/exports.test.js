/* eslint-env jest */
'use strict'

import Gw, { GatewaySwidge, GatewayClient, GatewaySwidgeError } from '../index.js'

test('exports surface', () => {
  expect(Gw).toBe(GatewaySwidge)
  expect(typeof GatewayClient).toBe('function')
  expect(typeof GatewaySwidgeError).toBe('function')
  const methods = ['quoteSwidge', 'swidge', 'getSwidgeStatus', 'getSupportedChains', 'getSupportedTokens',
    'swap', 'bridge', 'quoteSwap', 'quoteBridge']
  for (const m of methods) {
    expect(typeof GatewaySwidge.prototype[m]).toBe('function')
  }
})

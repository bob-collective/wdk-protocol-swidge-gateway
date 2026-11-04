import { describe, test, expect } from 'vitest'
import Gw, {
  GatewaySwidge,
  GatewayClient,
  GatewaySwidgeError,
  buildTronApproval,
} from '../src/index.js'

describe('exports surface', () => {
  test('default export is GatewaySwidge', () => {
    expect(Gw).toBe(GatewaySwidge)
    expect(typeof GatewayClient).toBe('function')
    expect(typeof GatewaySwidgeError).toBe('function')
    expect(typeof buildTronApproval).toBe('function')
    const methods = [
      'quoteSwidge',
      'swidge',
      'getSwidgeStatus',
      'getSupportedChains',
      'getSupportedTokens',
      'swap',
      'bridge',
      'quoteSwap',
      'quoteBridge',
    ]
    for (const m of methods) {
      expect(typeof GatewaySwidge.prototype[m as keyof typeof GatewaySwidge.prototype]).toBe(
        'function'
      )
    }
  })
})

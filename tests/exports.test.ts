import { describe, test, expect } from 'vitest'
import * as wdk from '@tetherto/wdk-wallet/protocols'
import Gw, {
  AccountRequiredError,
  BridgeError,
  GatewaySwidge,
  GatewayClient,
  GatewaySwidgeError,
  MaximumFeeExceededError,
  SwapError,
  SwidgeError,
  SwidgeErrorReason,
  ValueError,
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

  test('re-exports the WDK errors it throws — the same classes, so instanceof holds', () => {
    expect([
      AccountRequiredError,
      BridgeError,
      MaximumFeeExceededError,
      SwapError,
      SwidgeError,
      SwidgeErrorReason,
      ValueError,
    ]).toEqual([
      wdk.AccountRequiredError,
      wdk.BridgeError,
      wdk.MaximumFeeExceededError,
      wdk.SwapError,
      wdk.SwidgeError,
      wdk.SwidgeErrorReason,
      wdk.ValueError,
    ])
  })
})

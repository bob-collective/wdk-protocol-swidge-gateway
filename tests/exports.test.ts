import { describe, test, expect } from 'vitest'
import * as wdk from '@tetherto/wdk-wallet/protocols'
import Gw, {
  AccountRequiredError,
  BTC,
  BridgeError,
  GatewaySwidge,
  MaximumFeeExceededError,
  SwapError,
  SwidgeError,
  SwidgeErrorReason,
  ValueError,
} from '../src/index.js'

describe('exports', () => {
  test('the default export is GatewaySwidge', () => {
    expect(Gw).toBe(GatewaySwidge)
  })

  // WDK core registers a protocol by `instanceof SwidgeProtocol` against its own copy.
  test('GatewaySwidge extends the WDK SwidgeProtocol', () => {
    expect(Object.getPrototypeOf(GatewaySwidge)).toBe(wdk.SwidgeProtocol)
  })

  test.each(['swap', 'quoteSwap', 'bridge', 'quoteBridge'] as const)(
    'inherits %s() from SwidgeProtocol unchanged',
    (method) => {
      expect(GatewaySwidge.prototype[method]).toBe(wdk.SwidgeProtocol.prototype[method])
    }
  )

  test('BTC is the native-bitcoin token alias', () => {
    expect(BTC).toBe('BTC')
  })

  test.each([
    ['AccountRequiredError', AccountRequiredError, wdk.AccountRequiredError],
    ['BridgeError', BridgeError, wdk.BridgeError],
    ['MaximumFeeExceededError', MaximumFeeExceededError, wdk.MaximumFeeExceededError],
    ['SwapError', SwapError, wdk.SwapError],
    ['SwidgeError', SwidgeError, wdk.SwidgeError],
    ['SwidgeErrorReason', SwidgeErrorReason, wdk.SwidgeErrorReason],
    ['ValueError', ValueError, wdk.ValueError],
  ])('re-exports the WDK %s itself, so instanceof holds', (_name, ours, theirs) => {
    expect(ours).toBe(theirs)
  })
})

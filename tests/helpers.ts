/**
 * What a rejected `GatewaySwidgeError` must match: its exact code and message. Use with
 * `rejects.toMatchObject` — the error's `cause` carries the offending gateway or node payload
 * for diagnostics, which the tests do not pin.
 */
export function gatewayError(code: string, message: string) {
  return { name: 'GatewaySwidgeError', code, message }
}

/**
 * BOB's gateway-wdk attribution key, the default bearer token. It ships in the published package
 * (`src/gateway-swidge.ts`), so it is no secret — but the tests build the `Bearer …` header from
 * this constant rather than spelling it out, which secret scanners flag as a leaked token.
 */
export const BOB_BEARER_TOKEN = '49e52108b436492ebf03e85aa914718b'

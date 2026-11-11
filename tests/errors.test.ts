import { describe, test, expect } from 'vitest'
import { ERR, GatewaySwidgeError } from '../src/index.js'

describe('GatewaySwidgeError', () => {
  test('carries its code, HTTP status and cause', () => {
    const cause = new Error('dummy-cause')

    const error = new GatewaySwidgeError(ERR.HTTP, 'dummy-message', { status: 429, cause })

    expect(error.name).toBe('GatewaySwidgeError')
    expect(error.message).toBe('dummy-message')
    expect(error.code).toBe('GATEWAY_HTTP_ERROR')
    expect(error.status).toBe(429)
    expect(error.cause).toBe(cause)
  })

  test('leaves status and cause unset when not given', () => {
    const error = new GatewaySwidgeError(ERR.VALIDATION, 'dummy-message')

    expect(error.status).toBeUndefined()
    expect(error.cause).toBeUndefined()
  })

  test('is an Error subclass', () => {
    expect(Object.getPrototypeOf(GatewaySwidgeError.prototype)).toBe(Error.prototype)
  })
})

describe('ERR', () => {
  test('names every GatewaySwidgeError code', () => {
    expect(ERR).toEqual({
      HTTP: 'GATEWAY_HTTP_ERROR',
      VALIDATION: 'VALIDATION_ERROR',
      UNSUPPORTED_ROUTE: 'UNSUPPORTED_ROUTE',
      NOT_SUPPORTED: 'NOT_SUPPORTED',
      APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
    })
  })
})

/* eslint-env jest */
'use strict'

import { GatewaySwidgeError, ERR } from '../src/errors.js'

test('carries code, status and cause', () => {
  const e = new GatewaySwidgeError(ERR.HTTP, 'boom', { status: 429, cause: new Error('x') })
  expect(e.code).toBe(ERR.HTTP)
  expect(e.status).toBe(429)
  expect(e.cause.message).toBe('x')
  expect(e instanceof Error).toBe(true)
})

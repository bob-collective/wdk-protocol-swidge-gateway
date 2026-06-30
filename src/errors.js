'use strict'

export const ERR = {
  HTTP: 'GATEWAY_HTTP_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  UNSUPPORTED_ROUTE: 'UNSUPPORTED_ROUTE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED'
}

export class GatewaySwidgeError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, cause?: unknown }} [opts] */
  constructor (code, message, opts = {}) {
    super(message)
    this.name = 'GatewaySwidgeError'
    this.code = code
    this.status = opts.status
    this.cause = opts.cause
  }
}

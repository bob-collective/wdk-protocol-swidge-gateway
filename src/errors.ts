export const ERR = {
  HTTP: 'GATEWAY_HTTP_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  UNSUPPORTED_ROUTE: 'UNSUPPORTED_ROUTE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
} as const

export type ErrCode = (typeof ERR)[keyof typeof ERR]

export class GatewaySwidgeError extends Error {
  code: string
  status: number | undefined
  cause: unknown

  constructor(code: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message)
    this.name = 'GatewaySwidgeError'
    this.code = code
    this.status = opts.status
    this.cause = opts.cause
  }
}

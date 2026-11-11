/** The `code` values of a `GatewaySwidgeError`. */
export const ERR = {
  /** A gateway or chain-node request failed, or answered with something unusable. */
  HTTP: 'GATEWAY_HTTP_ERROR',
  /** An input, a gateway response or a built transaction failed a check. */
  VALIDATION: 'VALIDATION_ERROR',
  /** A route the gateway does not offer. Not thrown by this version: the gateway reports it as `HTTP`. */
  UNSUPPORTED_ROUTE: 'UNSUPPORTED_ROUTE',
  /** A chain, transaction type, account or runtime capability this module does not support. */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** A token approval is missing. Not thrown by this version: see `getRequiredApproval()`. */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
} as const

/** One of the `ERR` codes. */
export type ErrCode = (typeof ERR)[keyof typeof ERR]

/** An error raised by this module, classified by `code`. */
export class GatewaySwidgeError extends Error {
  /** The error class, one of `ERR`. */
  code: string
  /** The HTTP status of the failed gateway response, if any. */
  status: number | undefined
  /** The underlying error or the offending response body, if any. */
  cause: unknown

  /**
   * Creates a gateway swidge error.
   *
   * @param code - The error class, one of `ERR`.
   * @param message - The error message.
   * @param [opts] - The HTTP status and the underlying cause.
   */
  constructor(code: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message)
    this.name = 'GatewaySwidgeError'
    this.code = code
    this.status = opts.status
    this.cause = opts.cause
  }
}

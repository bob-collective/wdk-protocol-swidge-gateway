'use strict'

import { GatewaySwidgeError, ERR } from '../errors.js'

export const tronAdapter = {
  family: 'tron',

  async send () {
    throw new GatewaySwidgeError(ERR.NOT_SUPPORTED,
      'Tron is destination-only in v1: wdk-wallet-tron has no arbitrary-calldata send. ' +
      'Tracking: https://github.com/tetherto/wdk-wallet-tron/issues/48')
  }
}

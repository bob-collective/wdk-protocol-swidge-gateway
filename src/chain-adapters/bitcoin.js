'use strict'

import { GatewaySwidgeError, ERR } from '../errors.js'

/**
 * Chain adapter for native Bitcoin onramp.
 * Signs a PSBT via `account.signTransaction` and returns the raw hex so the
 * swidge layer can register it for gateway broadcast.
 */
export const bitcoinAdapter = {
  family: 'bitcoin',

  /**
   * Derive the deposit address from a BTC wallet account.
   * @param {{ getAddress: () => string }} account
   * @returns {Promise<string>}
   */
  async deriveAddress (account) {
    return account.getAddress()
  },

  /**
   * Sign the BTC transfer and return txid + raw hex.
   * @param {{ signTransaction: (params: { to: string, value: bigint, feeRate?: number }) => Promise<{ toHex: () => string, getId: () => string }> }} account
   * @param {{ address: string, amount: bigint }} payload
   * @param {{ feeRate?: number }} [opts]
   * @returns {Promise<{ txid: string, hex: string }>}
   */
  async send (account, payload, opts = {}) {
    if (typeof account.signTransaction !== 'function') {
      throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, 'bitcoin account cannot sign transactions')
    }
    const tx = await account.signTransaction({ to: payload.address, value: payload.amount, feeRate: opts.feeRate })
    return { txid: tx.getId(), hex: tx.toHex() }
  }
}

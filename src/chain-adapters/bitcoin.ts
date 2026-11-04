import * as ecc from '@bitcoinerlab/secp256k1'
import { Transaction, address as btcAddress, initEccLib, networks } from 'bitcoinjs-lib'
import { GatewaySwidgeError, ERR } from '../errors.js'

// Taproot (P2TR) deposit addresses cannot be parsed without an ECC library. Register ours here
// rather than relying on a wdk-wallet-btc version that happens to share our bitcoinjs-lib copy
// and initialize it for us — see tests/taproot-ecc.test.ts.
initEccLib(ecc)

interface BtcAccount {
  getAddress(): string | Promise<string>
  signTransaction?: (params: {
    to: string
    value: bigint
    feeRate?: number
  }) => Promise<string>
}

interface BtcPayload {
  address: string
  amount: bigint
  [key: string]: unknown
}

export interface BtcSimulateResult {
  signedTxHex: string
  txid: string
  valid: boolean
  paidToDeposit: bigint
}

export const bitcoinAdapter = {
  family: 'bitcoin' as const,

  async deriveAddress(account: BtcAccount): Promise<string> {
    return account.getAddress()
  },

  async send(
    account: BtcAccount,
    payload: BtcPayload,
    opts: { feeRate?: number } = {}
  ): Promise<{ txid: string; hex: string }> {
    if (typeof account.signTransaction !== 'function') {
      throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, 'bitcoin account cannot sign transactions')
    }
    const signedTxHex = await account.signTransaction({
      to: payload.address,
      value: payload.amount,
      feeRate: opts.feeRate,
    })
    const txid = Transaction.fromHex(signedTxHex).getId()
    return { txid, hex: signedTxHex }
  },

  /**
   * Sign WITHOUT broadcasting, then validate that at least one output pays
   * `payload.address` with total value ≥ `payload.amount`.
   * Returns the signed tx hex, txid, validation result, and the total satoshis
   * paid to the deposit address.
   */
  async simulate(
    account: BtcAccount,
    payload: BtcPayload,
    opts: { feeRate?: number } = {}
  ): Promise<BtcSimulateResult> {
    if (typeof account.signTransaction !== 'function') {
      throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, 'bitcoin account cannot sign transactions')
    }
    const signedTxHex = await account.signTransaction({
      to: payload.address,
      value: payload.amount,
      feeRate: opts.feeRate,
    })
    const parsed = Transaction.fromHex(signedTxHex)
    const txid = parsed.getId()
    const targetScript = btcAddress.toOutputScript(payload.address, networks.bitcoin)
    let paidToDeposit = 0n
    for (const out of parsed.outs) {
      if ((out.script as Buffer).equals(targetScript)) {
        paidToDeposit += BigInt(out.value)
      }
    }
    const valid = paidToDeposit >= payload.amount
    return { signedTxHex, txid, valid, paidToDeposit }
  },
}

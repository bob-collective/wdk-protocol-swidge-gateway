import { Transaction, address as btcAddress, networks } from 'bitcoinjs-lib'
import { GatewaySwidgeError, ERR } from '../errors.js'

interface BtcTx {
  toHex(): string
  getId(): string
}

interface BtcAccount {
  getAddress(): string | Promise<string>
  signTransaction?: (params: {
    to: string
    value: bigint
    feeRate?: number
  }) => Promise<BtcTx>
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
    const tx = await account.signTransaction({
      to: payload.address,
      value: payload.amount,
      feeRate: opts.feeRate,
    })
    return { txid: tx.getId(), hex: tx.toHex() }
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
    const tx = await account.signTransaction({
      to: payload.address,
      value: payload.amount,
      feeRate: opts.feeRate,
    })
    const signedTxHex = tx.toHex()
    const txid = tx.getId()

    const parsed = Transaction.fromHex(signedTxHex)
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

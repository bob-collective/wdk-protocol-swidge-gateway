import * as ecc from '@bitcoinerlab/secp256k1'
import { Transaction, address as btcAddress, initEccLib, networks } from 'bitcoinjs-lib'
import { GatewaySwidgeError, ERR } from '../errors.js'

// Taproot (P2TR) deposit addresses cannot be parsed without an ECC library. Register ours here
// rather than relying on a wdk-wallet-btc version that happens to share our bitcoinjs-lib copy
// and initialize it for us — see tests/taproot-ecc.test.ts.
initEccLib(ecc)

export interface BtcAccount {
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

/** Dry run of an onramp's source transaction. */
export interface BtcSimulateResult {
  /** The signed, unbroadcast Bitcoin transaction. */
  signedTxHex: string
  /** Its txid. */
  txid: string
  /** Whether the transaction pays the order's deposit address at least the quoted amount. */
  valid: boolean
  /** Satoshis the transaction pays to the deposit address. */
  paidToDeposit: bigint
}

/** Satoshis `tx` pays to `address`, summed over all of its outputs to that address. */
function paidTo(tx: Transaction, address: string): bigint {
  const script = btcAddress.toOutputScript(address, networks.bitcoin)
  let paid = 0n
  for (const out of tx.outs) {
    if ((out.script as Buffer).equals(script)) paid += BigInt(out.value)
  }
  return paid
}

export const bitcoinAdapter = {
  family: 'bitcoin' as const,

  async deriveAddress(account: BtcAccount): Promise<string> {
    return account.getAddress()
  },

  /**
   * Sign the deposit payment for broadcast by the gateway (register-tx), after checking that it
   * pays `payload.address` at least `payload.amount`. The account only signs, so a refused
   * transaction has gone nowhere.
   *
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if the account cannot sign transactions.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the signed transaction pays the deposit
   *   address less than `payload.amount`.
   */
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
    const tx = Transaction.fromHex(signedTxHex)
    const txid = tx.getId()
    // The gateway broadcasts whatever register-tx hands it, and swidge() reports the quoted amount
    // as paid: a signer that pays short (e.g. takes the fee out of the amount) must stop here.
    const paid = paidTo(tx, payload.address)
    if (paid < payload.amount) {
      throw new GatewaySwidgeError(
        ERR.VALIDATION,
        `signed transaction ${txid} pays the deposit address ${payload.address} ${paid} sats, ` +
          `less than the order's ${payload.amount}; it was not sent to the gateway`
      )
    }
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
    const paidToDeposit = paidTo(parsed, payload.address)
    const valid = paidToDeposit >= payload.amount
    return { signedTxHex, txid, valid, paidToDeposit }
  },
}

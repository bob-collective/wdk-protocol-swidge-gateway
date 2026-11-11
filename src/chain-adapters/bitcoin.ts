import * as ecc from '@bitcoinerlab/secp256k1'
import { Transaction, address as btcAddress, initEccLib, networks } from 'bitcoinjs-lib'
import { GatewaySwidgeError, ERR } from '../errors.js'

// Taproot (P2TR) deposit addresses cannot be parsed without an ECC library. Register ours here
// rather than relying on a wdk-wallet-btc version that happens to share our bitcoinjs-lib copy
// and initialize it for us — see the taproot deposit test in tests/simulate-swidge.test.ts.
initEccLib(ecc)

export interface BtcAccount {
  getAddress(): string | Promise<string>
  signTransaction?: (params: { to: string; value: bigint; feeRate?: number }) => Promise<string>
}

interface BtcPayload {
  address: string
  amount: bigint
  [key: string]: unknown
}

/**
 * Dry run of an onramp's source transaction. The signed transaction itself is left out: it pays
 * a real order's deposit address, so anyone holding it could broadcast it.
 */
export interface BtcSimulateResult {
  /** The txid of the signed, unbroadcast transaction. */
  txid: string
  /** Whether the transaction pays the order's deposit address exactly the quoted amount. */
  valid: boolean
  /** Satoshis the transaction pays to the deposit address. */
  paidToDeposit: bigint
}

/**
 * The output script of an order's deposit address; refuses anything but a standard mainnet address
 * (p2pkh, p2sh, p2wpkh, p2wsh, p2tr).
 */
function depositScript(address: string): Buffer {
  // bitcoinjs-lib accepts witness v2–16 ("future segwit") addresses with a console warning, but
  // nothing spends them under today's consensus rules: whoever sees the output can take it.
  let witnessVersion: number | undefined
  try {
    witnessVersion = btcAddress.fromBech32(address).version
  } catch {
    // Not bech32: toOutputScript decides.
  }
  if (witnessVersion !== undefined && witnessVersion > 1)
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `order deposit address has witness version ${witnessVersion}, which anyone can spend: ${address}`
    )
  try {
    return btcAddress.toOutputScript(address, networks.bitcoin)
  } catch (err) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `order deposit address is not a Bitcoin mainnet address: ${address}`,
      { cause: err }
    )
  }
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
    depositScript(payload.address)
    const signedTxHex = await account.signTransaction({
      to: payload.address,
      value: payload.amount,
      feeRate: opts.feeRate,
    })
    const txid = Transaction.fromHex(signedTxHex).getId()
    return { txid, hex: signedTxHex }
  },

  /**
   * Sign WITHOUT broadcasting, then check that the outputs to `payload.address` total exactly
   * `payload.amount`. Returns the txid, that check, and the satoshis paid to the deposit address
   * — never the signed transaction.
   */
  async simulate(
    account: BtcAccount,
    payload: BtcPayload,
    opts: { feeRate?: number } = {}
  ): Promise<BtcSimulateResult> {
    if (typeof account.signTransaction !== 'function') {
      throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, 'bitcoin account cannot sign transactions')
    }
    const targetScript = depositScript(payload.address)
    const signedTxHex = await account.signTransaction({
      to: payload.address,
      value: payload.amount,
      feeRate: opts.feeRate,
    })
    const parsed = Transaction.fromHex(signedTxHex)
    const txid = parsed.getId()
    let paidToDeposit = 0n
    for (const out of parsed.outs) {
      if ((out.script as Buffer).equals(targetScript)) {
        paidToDeposit += BigInt(out.value)
      }
    }
    const valid = paidToDeposit === payload.amount
    return { txid, valid, paidToDeposit }
  },
}

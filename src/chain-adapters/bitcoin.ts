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
}

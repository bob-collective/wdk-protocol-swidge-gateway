import { address as btcAddress } from 'bitcoinjs-lib'
import { GatewaySwidgeError, ERR } from './errors.js'

const TRON_VERSION_BYTE = 0x41

const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function toEvmAddress(addr: string): string {
  if (!TRON_BASE58.test(addr)) return addr
  try {
    const { version, hash } = btcAddress.fromBase58Check(addr)
    if (version !== TRON_VERSION_BYTE)
      throw new GatewaySwidgeError(ERR.VALIDATION, `not a Tron mainnet address: ${addr}`)
    return '0x' + Buffer.from(hash).toString('hex')
  } catch (err) {
    if (err instanceof GatewaySwidgeError) throw err
    throw new GatewaySwidgeError(ERR.VALIDATION, `not a valid Tron address: ${addr}`, {
      cause: err,
    })
  }
}

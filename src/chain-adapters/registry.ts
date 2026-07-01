import { bitcoinAdapter } from './bitcoin.js'
import { evmAdapter } from './evm.js'
import { tronAdapter } from './tron.js'
import { GatewaySwidgeError, ERR } from '../errors.js'

type Adapter = typeof bitcoinAdapter | typeof evmAdapter | typeof tronAdapter

const REGISTRY: Record<string, Adapter> = {
  bitcoin: bitcoinAdapter,
  evm: evmAdapter,
  tron: tronAdapter,
}

export function getAdapter(family: string): Adapter {
  const a = REGISTRY[family]
  if (!a) throw new GatewaySwidgeError(ERR.NOT_SUPPORTED, `chain family '${family}' is not supported in v1`)
  return a
}

export { GatewaySwidge, default } from './gateway-swidge.js'
export { GatewayClient } from './gateway-client.js'
export { GatewaySwidgeError, ERR } from './errors.js'
export type { SwidgeSimulation, BtcSimulateResult, EvmSimulateResult } from './types.js'

/**
 * Ergonomic constant for Bitcoin as the source or destination token.
 * Equivalent to passing `'BTC'` — normalised internally to the gateway's
 * native-token zero-address (`0x000...0`).  ERC-20/TRC-20 tokens should be
 * passed as their contract address.
 *
 * @example
 * import { GatewaySwidge, BTC } from '@gobob/wdk-protocol-swidge-gateway'
 * await sw.swidge({ fromToken: BTC, toToken: '0x...', ... })
 */
export const BTC = 'BTC'

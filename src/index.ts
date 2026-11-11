export { GatewaySwidge, default } from './gateway-swidge.js'
export type { GatewaySwidgeConfig } from './gateway-swidge.js'
export { GatewayClient } from './gateway-client.js'
export { GatewaySwidgeError, ERR } from './errors.js'
export { buildTronApproval } from './chain-adapters/tron.js'
export type { TronApprovalCall } from './chain-adapters/tron.js'
export type { GatewaySwidgeQuote } from './map/quote.js'
export type { Affiliate } from './map/options.js'
export type { GatewayClientConfig } from './gateway-client.js'
export type { HttpTransport } from './http.js'
export type { TronWebLike } from './chain-adapters/tron.js'

// WDK types this module's API is written in, re-exported so consumers need no direct
// dependency on @tetherto/wdk-wallet to type their calls.
export type { IWalletAccount, IWalletAccountReadOnly } from '@tetherto/wdk-wallet'
export type {
  SwidgeCommonOptions,
  SwidgeExactInOptions,
  SwidgeExactOutOptions,
  SwidgeFee,
  SwidgeFeeType,
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatus,
  SwidgeStatusOptions,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
  SwidgeTransaction,
} from '@tetherto/wdk-wallet/protocols'
// The WDK errors GatewaySwidge throws (swap()/bridge() wrap theirs in SwapError/BridgeError),
// so callers can catch them from this module.
export {
  AccountRequiredError,
  BridgeError,
  MaximumFeeExceededError,
  SwapError,
  SwidgeError,
  SwidgeErrorReason,
  ValueError,
} from '@tetherto/wdk-wallet/protocols'

export type {
  SwidgeSimulation,
  BtcSimulateResult,
  EvmRequiredApproval,
  EvmSimulateResult,
  TronSimulateResult,
} from './types.js'

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

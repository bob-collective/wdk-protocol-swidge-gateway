import {
  AccountRequiredError,
  SwidgeError,
  SwidgeErrorReason,
  SwidgeProtocol,
  ValueError,
} from '@tetherto/wdk-wallet/protocols'
import type { IWalletAccount, IWalletAccountReadOnly } from '@tetherto/wdk-wallet'
import type {
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeStatusOptions,
  SwidgeSupportedTokensOptions,
} from '@tetherto/wdk-wallet/protocols'
import { GatewayClient } from './gateway-client.js'
import type { GatewayClientConfig } from './gateway-client.js'
import { getAdapter } from './chain-adapters/registry.js'
import { evmAdapter, isNativeToken as isNativeEvmToken } from './chain-adapters/evm.js'
import { bitcoinAdapter } from './chain-adapters/bitcoin.js'
import { tronAdapter, isNativeToken as isNativeTronToken } from './chain-adapters/tron.js'
import type { TronAccount, TronOpts } from './chain-adapters/tron.js'
import type { EvmAccount, EvmRequiredApproval } from './chain-adapters/evm.js'
import type { BtcAccount } from './chain-adapters/bitcoin.js'
import { chainFamily, detectVariant, sameChain } from './chains.js'
import { isBtcAlias, toQuoteParams } from './map/options.js'
import type { Affiliate } from './map/options.js'
import { quoteSlippageBps, toSwidgeQuote } from './map/quote.js'
import type { GatewayQuoteV4, GatewaySwidgeQuote } from './map/quote.js'
import { assertFeeCaps } from './fee-caps.js'
import { toSwidgeStatus } from './map/status.js'
import { toSupportedChains, toSupportedTokens } from './map/routes.js'
import { orderPayload } from './map/order.js'
import type { OrderPayload } from './map/order.js'
import type { RegisterTxV4, SwidgeSimulation } from './types.js'
import { GatewaySwidgeError, ERR } from './errors.js'
import { assertAllowanceHolderSpender } from './allowance-holder.js'
import { assertOnrampAmount, assertOrderPayload, uint } from './order-guard.js'

const BOB_BEARER_TOKEN = '49e52108b436492ebf03e85aa914718b' // gateway-wdk attribution key

function assertPayloadFamily(payload: OrderPayload, srcFamily: string): void {
  const family = payload.kind === 'btc' ? 'bitcoin' : payload.kind
  if (family !== srcFamily) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `create-order returned a ${payload.kind} transaction for a ${srcFamily} route`,
      { cause: payload }
    )
  }
}

/**
 * The quote must be for the requested source chain, which the order tx is then checked against
 * (`assertOrderPayload`). Every variant but the onramp, whose quote has none, echoes `srcChain`.
 */
function assertQuoteSourceChain(
  quote: GatewayQuoteV4,
  variant: 'onramp' | 'offramp' | 'tokenSwap',
  srcChain: string
): void {
  const got = (quote[variant] as { srcChain?: unknown } | undefined)?.srcChain
  if (got == null && variant === 'onramp') return
  if (typeof got !== 'string' || !sameChain(got, srcChain)) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `quote source chain ${got} does not match the requested ${srcChain}`,
      { cause: quote }
    )
  }
}

/**
 * `minAmountOut` is compared with the quote's output amount, so that amount must be of the
 * requested token on the requested chain — else the floor is checked in another token's units.
 */
function assertQuoteOutput(
  quote: GatewayQuoteV4,
  variant: 'onramp' | 'offramp' | 'tokenSwap',
  dstToken: string,
  dstChain: string
): void {
  const out = (quote[variant] as { outputAmount?: { address?: unknown; chain?: unknown } })
    .outputAmount
  const token = out?.address
  const chain = out?.chain
  if (
    typeof token !== 'string' ||
    !sameToken(token, dstToken) ||
    typeof chain !== 'string' ||
    !sameChain(chain, dstChain)
  ) {
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `cannot verify minAmountOut: the quote's output is ${token} on ${chain}, not the requested ` +
        `${dstToken} on ${dstChain}`,
      { cause: quote }
    )
  }
}

/** EVM hex addresses compare case-insensitively; Base58Check (Tron) is case-sensitive. */
function sameToken(a: string, b: string): boolean {
  return a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The account methods `simulateSwidge()` and `getRequiredApproval()` reach per source family,
 * checked before any gateway call so an account without them leaves no orphaned order. A family
 * without an entry has no adapter and is refused as before.
 */
const SIMULATE_NEEDS: Record<string, string> = {
  bitcoin: 'signTransaction',
  evm: 'quoteSendTransaction',
  tron: 'getAddress',
}
const APPROVAL_NEEDS: Record<string, string> = { evm: 'getAllowance', tron: 'getAddress' }

/**
 * Checks on the quote, run before create-order so a refused swidge leaves no orphaned order, and
 * on the order tx, run before signing.
 */
interface OrderChecks {
  minAmountOut?: bigint
  caps?: SwidgeProtocolConfig
  /** Cap on the order tx's native `value` beyond the swapped amount; undefined → chain default. */
  maxNativeFee?: bigint
}

/**
 * Parse an integer base-unit amount option — a bigint, a safe integer or a decimal string — or
 * throw `ValueError` naming it. Decimal only, like every amount the order guard reads: `BigInt`
 * would also take `''` (as 0), whitespace, `'0x…'` and `'+…'`, and a number above
 * `Number.MAX_SAFE_INTEGER` may already have lost precision.
 */
function baseUnits(name: string, value: number | bigint | string): bigint {
  const n = uint(value)
  if (n !== null) return n
  // e.g. 0.02 BNB = 2e16 wei: an integer, but not exactly representable in general.
  const unsafe = typeof value === 'number' && Number.isInteger(value) && value > 0
  throw new ValueError(
    `${name} must be a non-negative integer amount in base units, got ${value}` +
      (unsafe ? ' (above Number.MAX_SAFE_INTEGER: pass a bigint or a decimal string)' : '')
  )
}

/** Configuration of a `GatewaySwidge` instance. */
export interface GatewaySwidgeConfig extends SwidgeProtocolConfig {
  /** Gateway API base URL (default: `https://gateway-api-mainnet.gobob.xyz`). */
  apiUrl?: string
  /** Gateway API bearer token (default: BOB's gateway-wdk attribution key). */
  bearerToken?: string
  /** HTTP transport for gateway requests (default: one built on the global `fetch`). */
  http?: GatewayClientConfig['http']
  /** Gateway client to use instead of building one from `apiUrl`, `bearerToken` and `http`. */
  client?: GatewayClient
  /** Affiliate fee recipients, sent on onramp and offramp quotes (token swaps take none). */
  affiliates?: Affiliate[]
  /** ERC-20 token an ERC-4337 account pays gas in through its paymaster. */
  paymasterToken?: string
  /**
   * Slippage tolerance as a fraction (`0.01` = 1%), used when a call sets none (default: the
   * gateway picks one per route and echoes it in the quote).
   */
  slippage?: number
  /** Bitcoin fee rate in sat/vB for onramp transactions (default: the account's own estimate). */
  feeRate?: number
  /** Source chain id, used when a call sets none. */
  fromChain?: string
  /**
   * Refund address on the source chain, used when a call sets none (default: the account's
   * address).
   */
  refundAddress?: string
  /** Tron routes: tronweb instance to build calls and read allowances (default: the account's). */
  tronWeb?: TronOpts['tronWeb']
  /** Tron routes: full-node URL to build a tronweb instance from, when `tronWeb` is unset. */
  tronProvider?: string
  /**
   * Tron routes: milliseconds a broadcast transaction is given to appear on the node before
   * `swidge()` throws (default: 20,000).
   */
  tronConfirmTimeoutMs?: number
  /**
   * Cap on native `value` the order tx may send on top of the swapped amount — the LayerZero /
   * CCIP messaging fee on ERC-20 token swaps — in `fromChain`'s native base units (wei, sun), so
   * it requires `fromChain` and applies only to calls from that chain; a call from another chain
   * uses its own `maxNativeFee` or that chain's default (default: a per-chain cap of roughly
   * $10–20 of the gas token).
   */
  maxNativeFee?: bigint | number | string
}

/** Per-call native-fee cap, overriding `GatewaySwidgeConfig.maxNativeFee`. */
type NativeFeeConfig = Pick<GatewaySwidgeConfig, 'maxNativeFee'>

/** What the chain adapters call on the account (see `GatewaySwidge#_signer`). */
type AdapterAccount = BtcAccount & EvmAccount & TronAccount

/**
 * WDK swidge protocol over the BOB Gateway V4 API: swaps and bridges between native BTC and
 * EVM/Tron tokens (onramp, offramp, token swap), signing only through the WDK account.
 */
export class GatewaySwidge extends SwidgeProtocol {
  private _client: GatewayClient
  private _affiliates: Affiliate[] | undefined
  private _paymasterToken: string | undefined
  private _slippage: number | undefined
  private _feeRate: number | undefined
  private _fromChain: string | undefined
  private _refundAddress: string | undefined
  private _tronOpts: TronOpts
  private _maxNativeFee: bigint | undefined
  private _spenderCache: Map<string, string>

  /**
   * Creates a gateway swidge protocol without an account. It can quote (given a `recipient`),
   * list routes and read order status; `swidge()` throws `AccountRequiredError`.
   *
   * @param account - No account.
   * @param config - The protocol configuration.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if the runtime has no global `fetch` and the
   *   configuration sets neither `http` nor `client`.
   * @throws {ValueError} If `config.maxNativeFee` is not a non-negative integer (a bigint, a safe
   *   integer or a decimal string), or is set without `config.fromChain`.
   */
  constructor(account?: undefined, config?: GatewaySwidgeConfig)
  /**
   * Creates a gateway swidge protocol for a read-only account. Quotes default the sender, refund
   * address and same-chain recipient to its address; `swidge()` throws `AccountRequiredError`.
   *
   * @param account - The read-only wallet account.
   * @param config - The protocol configuration.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if the runtime has no global `fetch` and the
   *   configuration sets neither `http` nor `client`.
   * @throws {ValueError} If `config.maxNativeFee` is not a non-negative integer (a bigint, a safe
   *   integer or a decimal string), or is set without `config.fromChain`.
   */
  constructor(account: IWalletAccountReadOnly, config?: GatewaySwidgeConfig)
  /**
   * Creates a gateway swidge protocol for a wallet account, which signs and sends the source
   * transaction of each swidge.
   *
   * @param account - The wallet account.
   * @param config - The protocol configuration.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if the runtime has no global `fetch` and the
   *   configuration sets neither `http` nor `client`.
   * @throws {ValueError} If `config.maxNativeFee` is not a non-negative integer (a bigint, a safe
   *   integer or a decimal string), or is set without `config.fromChain`.
   */
  constructor(account: IWalletAccount, config?: GatewaySwidgeConfig)
  constructor(account?: IWalletAccountReadOnly | IWalletAccount, config: GatewaySwidgeConfig = {}) {
    super(account as IWalletAccount, config)
    this._client =
      config.client ||
      new GatewayClient({
        apiUrl: config.apiUrl,
        bearerToken: config.bearerToken || BOB_BEARER_TOKEN,
        http: config.http,
      })
    this._affiliates = config.affiliates
    this._paymasterToken = config.paymasterToken
    this._slippage = config.slippage
    this._feeRate = config.feeRate
    this._fromChain = config.fromChain
    this._refundAddress = config.refundAddress
    this._tronOpts = {
      tronWeb: config.tronWeb,
      tronProvider: config.tronProvider,
      confirmTimeoutMs: config.tronConfirmTimeoutMs,
    }
    this._maxNativeFee =
      config.maxNativeFee == null ? undefined : baseUnits('maxNativeFee', config.maxNativeFee)
    if (this._maxNativeFee !== undefined && !config.fromChain) {
      throw new ValueError(
        'config.maxNativeFee is in the native units of config.fromChain: set fromChain, or pass ' +
          'maxNativeFee per call'
      )
    }
    this._spenderCache = new Map()
  }

  /**
   * Resolve source/destination chains and families.
   */
  private _resolveChains(options: { fromChain?: string; toChain?: string | number }): {
    fromChain: string
    toChain: string
    srcFamily: string
    dstFamily: string
  } {
    const fromChain = options.fromChain || this._fromChain
    if (!fromChain) throw new ValueError('source chain unknown: pass config.fromChain')
    // WDK types `toChain` as `string | number`; gateway chain ids are strings.
    const toChain =
      options.toChain != null && options.toChain !== '' ? String(options.toChain) : fromChain
    return {
      fromChain,
      toChain,
      srcFamily: chainFamily(fromChain),
      dstFamily: chainFamily(toChain),
    }
  }

  /**
   * Build quote params and derived context fields shared by quoteSwidge/swidge.
   */
  private async _buildQuoteParams(options: SwidgeOptions & { fromChain?: string }): Promise<{
    params: Record<string, string | undefined>
    variant: 'onramp' | 'offramp' | 'tokenSwap'
    srcFamily: string
    affiliateApplied: boolean
    fromChain: string
  }> {
    if (options.toTokenAmount != null) {
      throw new ValueError(
        'exact-out swidges (toTokenAmount) are not supported by the BOB Gateway: pass fromTokenAmount'
      )
    }
    if (options.fromTokenAmount == null) throw new ValueError('fromTokenAmount is required')
    const fromTokenAmount = baseUnits('fromTokenAmount', options.fromTokenAmount)
    const { fromChain, toChain, srcFamily, dstFamily } = this._resolveChains(options)
    // 'BTC' resolves to the zero address, which on any other chain is that chain's native gas
    // token — so a 'BTC' toToken with toChain left to default to an EVM source would swap into ETH.
    if (isBtcAlias(options.fromToken) && srcFamily !== 'bitcoin') {
      throw new ValueError(
        `fromToken 'BTC' is native bitcoin, but the source chain is ${fromChain}`
      )
    }
    if (isBtcAlias(options.toToken) && dstFamily !== 'bitcoin') {
      throw new ValueError(
        `toToken 'BTC' is native bitcoin, but the destination chain is ${toChain}` +
          (options.toChain == null || options.toChain === ''
            ? " (toChain defaults to the source chain): pass toChain: 'bitcoin'"
            : '')
      )
    }
    const variant = detectVariant({ srcFamily, dstFamily })
    const fromAddress =
      this._account && typeof this._account.getAddress === 'function'
        ? await this._account.getAddress()
        : undefined
    const refundAddress = this._refundAddress ?? fromAddress
    // A same-chain swap pays out to the sender by default. Cross-chain routes need an explicit
    // recipient: the sender's address may be invalid on the destination (another chain family) or
    // not controlled there (an ERC-4337 account is only deployed where it was deployed).
    const sameChain = toChain.toLowerCase() === fromChain.toLowerCase()
    const recipient = options.recipient ?? (sameChain ? fromAddress : undefined)
    if (!recipient) {
      throw new ValueError(
        sameChain
          ? 'recipient is required: pass options.recipient, or use an account with getAddress()'
          : `recipient is required for cross-chain routes (${fromChain} → ${toChain})`
      )
    }
    const params = toQuoteParams(
      {
        ...options,
        fromChain,
        toChain,
        recipient,
        fromTokenAmount,
      },
      {
        fromAddress,
        refundAddress,
        defaultSlippage: this._slippage,
        affiliates: this._affiliates,
        variant,
      }
    )
    const affiliateApplied = params.affiliates !== undefined
    return { params, variant, srcFamily, affiliateApplied, fromChain }
  }

  /**
   * Quotes a swidge without executing it. The quote is not binding: `swidge()` fetches its own.
   *
   * @param options - The swidge options.
   * @returns The quote: amounts, the slippage floor `toTokenAmountMin`, one fee line per fee in its
   *   own token, price impact and estimated duration.
   * @throws {ValueError} If `toTokenAmount` is set: exact-out swidges are not supported.
   * @throws {ValueError} If `fromTokenAmount` is missing or not a non-negative integer.
   * @throws {ValueError} If neither `options.fromChain` nor `config.fromChain` names the source
   *   chain.
   * @throws {ValueError} If `'BTC'` is the `fromToken` or `toToken` on a chain other than
   *   `bitcoin`.
   * @throws {ValueError} If a cross-chain route has no `recipient`, or a same-chain route has
   *   neither a `recipient` nor an account address to default to.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if `config.affiliates` is invalid on an onramp
   *   or offramp: more than 5 entries, a missing or duplicate address, a non-positive `bps`, or
   *   more than 1000 bps in total.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if a gateway request fails (transient
   *   errors are retried first).
   */
  async quoteSwidge(options: SwidgeOptions): Promise<GatewaySwidgeQuote> {
    const { params, affiliateApplied } = await this._buildQuoteParams(options)
    const gw = (await this._client.getQuote(params)) as GatewayQuoteV4
    return toSwidgeQuote(gw, { affiliateApplied })
  }

  /**
   * The account as the chain adapters call it. WDK types `IWalletAccount` chain-agnostically
   * (`signTransaction` resolves to `unknown`); the chain's own account class (`WalletAccountBtc`,
   * `WalletAccountEvm`, `WalletAccountTron`) provides the narrower methods each adapter uses, and
   * `_assertCanSign` checks the signing method at runtime before `swidge()` reaches an adapter.
   */
  private get _signer(): AdapterAccount {
    return this._account as unknown as AdapterAccount
  }

  /** Fail fast — before any gateway call — when the account lacks a method `op` reaches. */
  private _assertAccountHas(op: string, method: string | undefined): void {
    if (method === undefined) return
    const account = this._account as Record<string, unknown> | undefined
    if (typeof account?.[method] !== 'function') {
      throw new AccountRequiredError(`${op} needs an account that implements ${method}()`)
    }
  }

  /** Fail fast — before any gateway call — when the account cannot sign on the source chain. */
  private _assertCanSign(srcFamily: string): void {
    const method = srcFamily === 'bitcoin' ? 'signTransaction' : 'sendTransaction'
    const account = this._account as Partial<Record<typeof method, unknown>> | undefined
    if (typeof account?.[method] !== 'function') {
      throw new AccountRequiredError(
        `swidge() needs a full account that implements ${method}(); a read-only account can ` +
          'only quote'
      )
    }
  }

  /**
   * Swaps and/or bridges tokens: quotes, checks the quote, creates a gateway order, then signs
   * and submits its source transaction. Onramps hand the signed Bitcoin transaction to the gateway,
   * which broadcasts it; offramps and token swaps broadcast from the account. The quote checks run
   * before the order is created, so a quote they refuse leaves no order behind; the order
   * transaction is checked after, before anything signs.
   *
   * @param options - The swidge options.
   * @param config - Per-call fee caps (overriding the instance's cap by cap), `maxNativeFee`
   *   (overriding the instance's) and the paymaster token an ERC-4337 account pays gas in.
   * @returns The order id, the source transaction hash, the quoted amounts and the fee lines.
   * @throws {AccountRequiredError} If the account cannot sign on the source chain: it has no
   *   `signTransaction` (Bitcoin) or `sendTransaction` (EVM, Tron). Thrown before any gateway call.
   * @throws {ValueError} If `toTokenAmount` is set: exact-out swidges are not supported.
   * @throws {ValueError} If `fromTokenAmount` is missing or not a non-negative integer.
   * @throws {ValueError} If neither `options.fromChain` nor `config.fromChain` names the source
   *   chain.
   * @throws {ValueError} If `'BTC'` is the `fromToken` or `toToken` on a chain other than
   *   `bitcoin`.
   * @throws {ValueError} If a cross-chain route has no `recipient`, or a same-chain route has
   *   neither a `recipient` nor an account address to default to.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if `config.affiliates` is invalid on an onramp
   *   or offramp: more than 5 entries, a missing or duplicate address, a non-positive `bps`, or
   *   more than 1000 bps in total.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if a gateway request fails (transient
   *   errors are retried first).
   * @throws {ValueError} If `minAmountOut` is not a non-negative integer.
   * @throws {ValueError} If `maxNetworkFeeBps` or `maxProtocolFeeBps` is not a finite,
   *   non-negative number.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if `minAmountOut` is above 0 but the quote
   *   echoes no slippage to derive its floor from, or its output is not `toToken` on `toChain`.
   * @throws {SwidgeError} `COULD_NOT_MET_THRESHOLD` if the quote's `toTokenAmountMin` is below
   *   `minAmountOut`.
   * @throws {MaximumFeeExceededError} If a fee exceeds `maxNetworkFeeBps` or `maxProtocolFeeBps`.
   * @throws {MaximumFeeExceededError} If a set fee cap cannot be verified: the quote lacks the fee
   *   breakdown or a USD price the cap needs.
   * @throws {ValueError} If `maxNativeFee` (per call or configured) is not a non-negative
   *   integer: a bigint, a safe integer or a decimal string.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if no refund address resolves: none in
   *   `options.refundAddress` or `config.refundAddress`, and no account address.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the quote is for another source chain than
   *   the requested one.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if an onramp quote's BTC amount is not
   *   `fromTokenAmount`; thrown before create-order.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if get-quote returns no quote for the route's
   *   variant, or create-order returns no order id or no transaction.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if create-order returns a transaction type this
   *   module cannot sign (e.g. `solana`).
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if create-order returns a transaction for
   *   another chain family than the route's.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the create-order transaction does not match
   *   the request: not an AllowanceHolder `exec` call on the holder pinned for the source chain,
   *   built for another chain, moving another token or more than `fromTokenAmount`, sending more
   *   native value than `maxNativeFee` on top of the swapped amount, or (Tron) a `feeLimit` above
   *   100 TRX. Thrown before signing.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if register-tx fails or reports another txid
   *   than the one signed (onramp). The transaction may still have been broadcast: check the chain
   *   or `getSwidgeStatus()` before resending.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if a Tron source has no tronweb instance
   *   (`config.tronWeb`, `config.tronProvider` or the account's own), or its provider cannot read
   *   transactions back.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if a Tron order call is malformed (empty
   *   calldata, a `value` or `feeLimit` that is not a safe non-negative integer, a zero
   *   `feeLimit`), `config.tronConfirmTimeoutMs` is invalid, or the node-built transaction differs
   *   from the order call.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the Tron node rejects the order call, or
   *   the broadcast transaction is not found on the node within `tronConfirmTimeoutMs`.
   */
  async swidge(
    options: SwidgeOptions,
    config: SwidgeProtocolConfig & NativeFeeConfig & { paymasterToken?: string } = {}
  ): Promise<SwidgeResult> {
    const route = this._resolveChains(options)
    this._assertCanSign(route.srcFamily)
    const maxNativeFee = this._resolveMaxNativeFee(config, route.fromChain)
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const { swidgeQuote: sq, payload } = await this._createOrder(params, variant, srcFamily, {
      minAmountOut: this._minAmountOut(options),
      caps: this._caps(config),
      maxNativeFee,
    })
    const adapter = getAdapter(srcFamily)

    let txid: string
    if (payload.kind === 'btc') {
      const { txid: id, hex } = await (adapter as typeof bitcoinAdapter).send(
        this._signer,
        { ...payload },
        { feeRate: this._feeRate }
      )
      await this._registerOnramp({ onramp: { order_id: payload.orderId, bitcoin_tx_hex: hex } }, id)
      txid = id
    } else {
      // V4 has no offramp/tokenSwap register-tx: the gateway indexes the source tx from chain.
      const sent =
        payload.kind === 'tron'
          ? await (adapter as typeof tronAdapter).send(this._signer, { ...payload }, this._tronOpts)
          : await (adapter as typeof evmAdapter).send(
              this._signer,
              { ...payload },
              {
                aaConfig: this._aaConfig(config),
              }
            )
      txid = sent.txid
    }

    return {
      id: payload.orderId,
      hash: txid,
      fees: sq.fees,
      transactions: [{ hash: txid, chain: fromChain, type: 'source' }],
      fromTokenAmount: sq.fromTokenAmount,
      toTokenAmount: sq.toTokenAmount,
      toTokenAmountMin: sq.toTokenAmountMin,
    }
  }

  /** Per-call caps override the instance's, cap by cap. */
  private _caps(config: SwidgeProtocolConfig | null): SwidgeProtocolConfig {
    // `null` from JS callers, as `_aaConfig` tolerates it.
    return {
      maxNetworkFeeBps: config?.maxNetworkFeeBps ?? this._config.maxNetworkFeeBps,
      maxProtocolFeeBps: config?.maxProtocolFeeBps ?? this._config.maxProtocolFeeBps,
    }
  }

  private _minAmountOut(options: SwidgeOptions): bigint | undefined {
    return options.minAmountOut == null
      ? undefined
      : baseUnits('minAmountOut', options.minAmountOut)
  }

  /**
   * Quote → checks → create-order → payload. The quote checks run before create-order, so a quote
   * they refuse leaves no orphaned order. The payload's family is then checked against the route's,
   * and the transaction itself against what was asked for (`assertOrderPayload`), before anything
   * signs.
   */
  private async _createOrder(
    params: Record<string, string | undefined>,
    variant: 'onramp' | 'offramp' | 'tokenSwap',
    srcFamily: string,
    checks: OrderChecks = {}
  ): Promise<{ swidgeQuote: GatewaySwidgeQuote; payload: OrderPayload }> {
    if (!params.refundAddress) {
      throw new GatewaySwidgeError(
        ERR.VALIDATION,
        'refundAddress required: pass options.refundAddress or config.refundAddress, or use an ' +
          'account with getAddress()'
      )
    }
    const response = (await this._client.getQuote(params)) as GatewayQuoteV4
    if (response?.[variant] == null) {
      throw new GatewaySwidgeError(ERR.HTTP, `get-quote returned no ${variant} quote`, {
        cause: response,
      })
    }
    // Only the requested variant: it is what create-order posts, so every check must read it —
    // not whichever variant key `innerQuote()` finds first.
    const quote: GatewayQuoteV4 = { [variant]: response[variant] }
    assertQuoteSourceChain(quote, variant, params.srcChain as string)
    // Decimal: _buildQuoteParams parsed and re-serialized it.
    const amount = BigInt(params.amount as string)
    if (variant === 'onramp') assertOnrampAmount(quote, amount)
    const swidgeQuote = toSwidgeQuote(quote, { affiliateApplied: params.affiliates !== undefined })
    // A floor of 0 holds for any output: nothing to verify.
    if (checks.minAmountOut !== undefined && checks.minAmountOut > 0n) {
      assertQuoteOutput(quote, variant, params.dstToken as string, params.dstChain as string)
      // Without the echoed slippage no floor is known (toTokenAmountMin is 0): say so, rather than
      // report it as a threshold miss.
      if (quoteSlippageBps(quote) === null) {
        throw new GatewaySwidgeError(
          ERR.VALIDATION,
          'cannot verify minAmountOut: the quote carries no slippage to derive its minimum from',
          { cause: quote }
        )
      }
      const { toTokenAmountMin } = swidgeQuote
      if (toTokenAmountMin < checks.minAmountOut) {
        throw new SwidgeError(
          `quote guarantees at least ${toTokenAmountMin} of the destination token after slippage, ` +
            `below minAmountOut ${checks.minAmountOut}`,
          { reason: SwidgeErrorReason.COULD_NOT_MET_THRESHOLD }
        )
      }
    }
    if (checks.caps) assertFeeCaps(quote, variant, checks.caps)
    const order = (await this._client.createOrder(quote)) as Record<string, unknown>
    const payload = orderPayload(order, variant, quote)
    assertPayloadFamily(payload, srcFamily)
    assertOrderPayload(payload, {
      chain: params.srcChain as string,
      token: params.srcToken as string,
      amount,
      maxNativeFee: checks.maxNativeFee,
    })
    return { swidgeQuote, payload }
  }

  /**
   * The native-fee cap for one call from `fromChain`: `config.maxNativeFee` if given; else the
   * instance's, which is in `config.fromChain`'s native units and so only applies on that chain;
   * else undefined (→ the chain default). `swidge()`, `simulateSwidge()` and
   * `getRequiredApproval()` all resolve it here, so an order one of them accepts the others accept
   * too.
   */
  private _resolveMaxNativeFee(
    config: NativeFeeConfig | null,
    fromChain: string
  ): bigint | undefined {
    // `null` from JS callers, as `_aaConfig` tolerates it.
    const perCall = config?.maxNativeFee
    if (perCall != null) return baseUnits('maxNativeFee', perCall)
    // 0.005 ETH sized for one chain would be 0.005 POL on another — or the reverse, 50 POL as ETH.
    return this._fromChain && sameChain(fromChain, this._fromChain) ? this._maxNativeFee : undefined
  }

  private _aaConfig(config: { paymasterToken?: string }): unknown {
    const pm = (config && config.paymasterToken) || this._paymasterToken
    return pm ? { paymasterToken: pm } : undefined
  }

  /**
   * Hand the signed onramp tx to the gateway for broadcast, and check that the txid it reports
   * is the one we signed. A failure can follow a broadcast that did go out (e.g. a retry after a
   * lost response), so the error never claims the tx was not sent.
   */
  private async _registerOnramp(body: RegisterTxV4, txid: string): Promise<void> {
    let res: unknown
    try {
      res = await this._client.registerTx(body)
    } catch (err) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `register-tx failed for order ${body.onramp.order_id}: bitcoin transaction ${txid} may ` +
          'or may not have been broadcast — check the chain before resending',
        { status: (err as { status?: number })?.status, cause: err }
      )
    }
    const reported = (res as { onramp?: { txid?: unknown } } | null)?.onramp?.txid
    const norm = (id: string) => id.toLowerCase().replace(/^0x/, '')
    if (typeof reported !== 'string' || norm(reported) !== norm(txid)) {
      throw new GatewaySwidgeError(
        ERR.HTTP,
        `register-tx reported txid ${reported} for order ${body.onramp.order_id}, expected ${txid}`,
        { cause: res }
      )
    }
  }

  /**
   * Dry-runs a swidge: runs `swidge()`'s quote, checks and create-order, then signs (onramp) or
   * estimates (offramp, token swap) the source transaction without broadcasting it. The gateway
   * order this creates is never funded; the gateway reconciles such orders.
   *
   * @param options - The swidge options.
   * @param config - Per-call fee caps and `maxNativeFee`, as for `swidge()`.
   * @returns The dry run: the order id, the quote and, per source chain, the signed transaction
   *   or the fee estimate, the approval still required, and whether the transaction is valid.
   * @throws {ValueError} If `toTokenAmount` is set: exact-out swidges are not supported.
   * @throws {ValueError} If `fromTokenAmount` is missing or not a non-negative integer.
   * @throws {ValueError} If neither `options.fromChain` nor `config.fromChain` names the source
   *   chain.
   * @throws {ValueError} If `'BTC'` is the `fromToken` or `toToken` on a chain other than
   *   `bitcoin`.
   * @throws {ValueError} If a cross-chain route has no `recipient`, or a same-chain route has
   *   neither a `recipient` nor an account address to default to.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if `config.affiliates` is invalid on an onramp
   *   or offramp: more than 5 entries, a missing or duplicate address, a non-positive `bps`, or
   *   more than 1000 bps in total.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if a gateway request fails (transient
   *   errors are retried first).
   * @throws {ValueError} If `minAmountOut` is not a non-negative integer.
   * @throws {ValueError} If `maxNetworkFeeBps` or `maxProtocolFeeBps` is not a finite,
   *   non-negative number.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if `minAmountOut` is above 0 but the quote
   *   echoes no slippage to derive its floor from, or its output is not `toToken` on `toChain`.
   * @throws {SwidgeError} `COULD_NOT_MET_THRESHOLD` if the quote's `toTokenAmountMin` is below
   *   `minAmountOut`.
   * @throws {MaximumFeeExceededError} If a fee exceeds `maxNetworkFeeBps` or `maxProtocolFeeBps`.
   * @throws {MaximumFeeExceededError} If a set fee cap cannot be verified: the quote lacks the fee
   *   breakdown or a USD price the cap needs.
   * @throws {ValueError} If `maxNativeFee` (per call or configured) is not a non-negative
   *   integer: a bigint, a safe integer or a decimal string.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if no refund address resolves: none in
   *   `options.refundAddress` or `config.refundAddress`, and no account address.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the quote is for another source chain than
   *   the requested one.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if an onramp quote's BTC amount is not
   *   `fromTokenAmount`; thrown before create-order.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if get-quote returns no quote for the route's
   *   variant, or create-order returns no order id or no transaction.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if create-order returns a transaction type this
   *   module cannot sign (e.g. `solana`).
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if create-order returns a transaction for
   *   another chain family than the route's.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the create-order transaction does not match
   *   the request: not an AllowanceHolder `exec` call on the holder pinned for the source chain,
   *   built for another chain, moving another token or more than `fromTokenAmount`, sending more
   *   native value than `maxNativeFee` on top of the swapped amount, or (Tron) a `feeLimit` above
   *   100 TRX. Thrown before signing.
   * @throws {AccountRequiredError} If the account lacks the method the dry run calls, before any
   *   gateway call: `signTransaction` (Bitcoin), `quoteSendTransaction` (EVM) or `getAddress`
   *   (Tron).
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if an approval is due and its spender is not
   *   the AllowanceHolder pinned for the source chain, or the chain has none pinned.
   */
  async simulateSwidge(
    options: SwidgeOptions & { fromChain?: string },
    config: SwidgeProtocolConfig & NativeFeeConfig = {}
  ): Promise<SwidgeSimulation> {
    const route = this._resolveChains(options)
    this._assertAccountHas('simulateSwidge()', SIMULATE_NEEDS[route.srcFamily])
    const maxNativeFee = this._resolveMaxNativeFee(config, route.fromChain)
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    const { swidgeQuote: sq, payload } = await this._createOrder(params, variant, srcFamily, {
      minAmountOut: this._minAmountOut(options),
      caps: this._caps(config),
      maxNativeFee,
    })
    const adapter = getAdapter(srcFamily)
    const common = {
      variant,
      orderId: payload.orderId,
      quote: sq as unknown as Record<string, unknown>,
      broadcast: false as const,
    }

    if (payload.kind === 'btc') {
      return {
        ...common,
        onramp: await (adapter as typeof bitcoinAdapter).simulate(
          this._signer,
          { ...payload },
          { feeRate: this._feeRate }
        ),
      }
    }
    const approvalOpts = {
      token: (options as { fromToken?: string }).fromToken,
      spender: payload.tx.to,
      amount: options.fromTokenAmount,
    }
    if (payload.kind === 'tron') {
      const tron = await (adapter as typeof tronAdapter).simulate(
        this._signer,
        { ...payload },
        { ...this._tronOpts, ...approvalOpts }
      )
      if (tron.requiredApproval)
        assertAllowanceHolderSpender(fromChain, tron.requiredApproval.spender)
      return { ...common, tron }
    }
    const evm = await (adapter as typeof evmAdapter).simulate(
      this._signer,
      { ...payload },
      { ...approvalOpts, chain: fromChain }
    )
    if (evm.requiredApproval) assertAllowanceHolderSpender(fromChain, evm.requiredApproval.spender)
    return { ...common, evm }
  }

  /**
   * Returns the status of a gateway order.
   *
   * @param id - The order id `swidge()` returned.
   * @param _options - The status options; unused.
   * @returns The order status and every transaction hash it exposes: source, destination payouts
   *   and refunds.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway request fails (transient
   *   errors are retried first).
   */
  async getSwidgeStatus(id: string, _options?: SwidgeStatusOptions): Promise<SwidgeStatusResult> {
    const order = await this._client.getOrder(id)
    return toSwidgeStatus(order as Parameters<typeof toSwidgeStatus>[0])
  }

  /**
   * Returns the chains the gateway routes from or to.
   *
   * @returns The supported chains, each with its name, type and native token.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway request fails (transient
   *   errors are retried first).
   */
  async getSupportedChains(): Promise<SwidgeSupportedChain[]> {
    return toSupportedChains(
      (await this._client.getRoutes()) as Parameters<typeof toSupportedChains>[0]
    )
  }

  /**
   * Returns the tokens the gateway routes, with their symbol and decimals. Tokens this module has
   * no metadata for are omitted.
   *
   * @param [options] - The filter: `fromChain` keeps the tokens routable from that chain.
   * @returns The supported tokens.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the gateway request fails (transient
   *   errors are retried first).
   */
  async getSupportedTokens(
    options?: SwidgeSupportedTokensOptions
  ): Promise<SwidgeSupportedToken[]> {
    const opts = options
      ? { fromChain: options.fromChain != null ? String(options.fromChain) : undefined }
      : {}
    return toSupportedTokens(
      (await this._client.getRoutes()) as Parameters<typeof toSupportedTokens>[0],
      opts
    )
  }

  /**
   * Returns the ERC-20/TRC-20 approval the account must grant before an offramp or token-swap
   * swidge: an unbounded allowance to the gateway's AllowanceHolder.
   *
   * On a cache miss this creates a gateway order to learn the spender (the V4 API has no
   * read-only lookup); the spender is cached per route on this instance, so call it once per
   * route, not before every swap. An onramp or a native source token needs no approval, so it
   * returns `null` without creating one.
   *
   * USDT on Ethereum cannot move between two non-zero allowances; when a stale non-zero allowance
   * is in place the result carries `resetRequired: true`, and the caller must first send
   * `approve({ token, spender, amount: 0n })`, then approve `amount`.
   *
   * @param options - The swidge options; `fromToken` and `toToken` are required.
   * @param [config] - Per-call settings; only `maxNativeFee` is read, as for `swidge()`.
   * @returns The approval to grant, or `null` when the current allowance covers `fromTokenAmount`
   *   or the route needs none (onramp, native source token).
   * @throws {AccountRequiredError} If an approval may be due and the account lacks the method that
   *   reads the allowance, before any gateway call: `getAllowance` (EVM) or `getAddress` (Tron).
   * @throws {ValueError} If `fromTokenAmount` is missing or not a non-negative integer.
   * @throws {ValueError} If neither `options.fromChain` nor `config.fromChain` names the source
   *   chain.
   * @throws {ValueError} If `'BTC'` is the `fromToken` or `toToken` on a chain other than
   *   `bitcoin`.
   * @throws {ValueError} If a cross-chain route has no `recipient`, or a same-chain route has
   *   neither a `recipient` nor an account address to default to.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if `config.affiliates` is invalid on an offramp:
   *   more than 5 entries, a missing or duplicate address, a non-positive `bps`, or more than
   *   1000 bps in total.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if a gateway request fails (transient
   *   errors are retried first).
   * @throws {ValueError} If `maxNativeFee` (per call or configured) is not a non-negative
   *   integer: a bigint, a safe integer or a decimal string.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if no refund address resolves: none in
   *   `options.refundAddress` or `config.refundAddress`, and no account address.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the quote is for another source chain than
   *   the requested one.
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if get-quote returns no quote for the route's
   *   variant, or create-order returns no order id or no transaction.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if create-order returns a transaction type this
   *   module cannot sign (e.g. `solana`).
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if create-order returns a transaction for
   *   another chain family than the route's.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the create-order transaction (fetched on a
   *   cache miss) does not match the request: not an AllowanceHolder `exec` call on the holder
   *   pinned for the source chain, built for another chain, moving another token or more than
   *   `fromTokenAmount`, sending more native value than `maxNativeFee` on top of the swapped
   *   amount, or (Tron) a `feeLimit` above 100 TRX.
   * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if an approval is due and its spender is not
   *   the AllowanceHolder pinned for the source chain, or the chain has none pinned.
   * @throws {GatewaySwidgeError} `NOT_SUPPORTED` if a Tron source has no tronweb instance
   *   (`config.tronWeb`, `config.tronProvider` or the account's own).
   * @throws {GatewaySwidgeError} `GATEWAY_HTTP_ERROR` if the Tron node rejects the allowance read
   *   or answers with anything but one 32-byte word.
   */
  async getRequiredApproval(
    options: SwidgeOptions & {
      fromToken: string
      toToken: string
      fromTokenAmount: bigint | string | number
    },
    config: NativeFeeConfig = {}
  ): Promise<EvmRequiredApproval | null> {
    const maxNativeFee = this._resolveMaxNativeFee(config, this._resolveChains(options).fromChain)
    const { params, variant, srcFamily, fromChain } = await this._buildQuoteParams(options)
    // Neither needs an approval, so neither needs the order that finds the spender.
    if (variant === 'onramp') return null
    const isNative = srcFamily === 'tron' ? isNativeTronToken : isNativeEvmToken
    if (isNative(params.srcToken as string)) return null
    this._assertAccountHas('getRequiredApproval()', APPROVAL_NEEDS[srcFamily])
    const key = `${fromChain}:${variant}:${options.fromToken}:${options.toToken}:${(options.toChain as string) || ''}`
    let spender: string
    if (this._spenderCache.has(key)) {
      spender = this._spenderCache.get(key)!
    } else {
      const { payload } = await this._createOrder(params, variant, srcFamily, { maxNativeFee })
      if (payload.kind === 'btc')
        throw new Error('expected a contract-call payload for approval check')
      spender = payload.tx.to
      this._spenderCache.set(key, spender)
    }
    const approval =
      srcFamily === 'tron'
        ? await tronAdapter.getRequiredApproval(
            this._signer,
            options.fromToken,
            spender,
            options.fromTokenAmount,
            this._tronOpts
          )
        : await evmAdapter.getRequiredApproval(
            this._signer,
            options.fromToken,
            spender,
            options.fromTokenAmount,
            { chain: fromChain }
          )
    if (approval) assertAllowanceHolderSpender(fromChain, approval.spender)
    return approval
  }
}

export default GatewaySwidge

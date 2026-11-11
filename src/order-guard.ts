import { GatewaySwidgeError, ERR } from './errors.js'
import { allowanceHolderFor, toHexAddress } from './allowance-holder.js'
import { sameChain } from './chains.js'
import type { OrderPayload } from './map/order.js'
import type { GatewayQuoteV4 } from './map/quote.js'
import { DEFAULT_FEE_LIMIT_SUN } from './chain-adapters/tron.js'

/** `exec(address operator, address token, uint256 amount, address target, bytes data)`. */
export const EXEC_SELECTOR = '2213bc0b'

const ZERO = '0x0000000000000000000000000000000000000000'
const WORD = 64 // hex chars per ABI word

const ETH = 10n ** 18n
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Ceiling on a Tron order's `feeLimit` (sun): the gateway's own `TRON_DEFAULT_FEE_LIMIT_SUN`, and
 * this module's default when the order omits it. `feeLimit` is how much TRX the call may burn for
 * energy, so an unbounded one would let a hostile inner call burn the account's TRX.
 */
export const MAX_TRON_FEE_LIMIT_SUN = 100_000_000n

/**
 * Default `maxNativeFee` per source chain, in the native token's base units (wei; sun on Tron):
 * roughly $10–20 of each chain's gas token at the time of writing. ERC-20 token swaps over a
 * LayerZero OFT or CCIP pay the bridge's messaging fee in native `value` on top of the token
 * amount — the gateway estimates it server-side and the quote does not expose it — so the order
 * tx's `value` can't be required to be 0. These caps sit well above typical messaging fees while
 * bounding what a wrong or hostile create-order response could take from the native balance.
 */
const DEFAULT_MAX_NATIVE_FEE: Record<string, bigint> = {
  ethereum: (5n * ETH) / 1000n, // 0.005 ETH
  base: (5n * ETH) / 1000n,
  arbitrum: (5n * ETH) / 1000n,
  bob: (5n * ETH) / 1000n,
  unichain: (5n * ETH) / 1000n,
  robinhood: (5n * ETH) / 1000n,
  bsc: (2n * ETH) / 100n, // 0.02 BNB
  avalanche: ETH / 2n, // 0.5 AVAX
  polygon: 50n * ETH, // 50 POL
  hyperevm: ETH / 2n, // 0.5 HYPE
  hyperliquid: ETH / 2n,
  plasma: 20n * ETH, // 20 XPL
  tron: 50_000_000n, // 50 TRX
}

/** What the caller asked for, to hold the create-order transaction against. */
export interface OrderGuardContext {
  /** Gateway source chain id. */
  chain: string
  /** Source token id as sent to the gateway (EVM hex, Tron Base58Check, or the zero address). */
  token: string
  /** Requested `fromTokenAmount`, in base units. */
  amount: bigint
  /** Cap on native `value` beyond `amount`; undefined → the chain's default. */
  maxNativeFee?: bigint
}

interface ExecCall {
  operator: string
  token: string
  amount: bigint
  target: string
}

function refuse(message: string, cause?: unknown): never {
  throw new GatewaySwidgeError(ERR.VALIDATION, `refusing to sign the order: ${message}`, { cause })
}

/** A non-negative integer from a bigint, a safe integer, or a plain decimal string; else null. */
export function uint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  // Decimal digits only: `BigInt` would also take '', whitespace, '0x…', '0o…' and '+…', which
  // other parsers (the gateway's, tronweb's `Number`) may read differently.
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value)
  return null
}

/**
 * Parse a non-negative integer amount — a bigint, a safe integer or a decimal string — or throw a
 * validation error naming `field`.
 */
export function parseBaseUnits(field: string, value: unknown): bigint {
  const n = uint(value)
  if (n === null) {
    // e.g. 0.02 BNB = 2e16 wei: an integer, but not exactly representable in general.
    const unsafe = typeof value === 'number' && Number.isInteger(value) && value > 0
    throw new GatewaySwidgeError(
      ERR.VALIDATION,
      `${field} must be a non-negative integer in base units, got ${String(value)}` +
        (unsafe ? ' (above Number.MAX_SAFE_INTEGER: pass a bigint or a decimal string)' : '')
    )
  }
  return n
}

/** An order tx amount field; absent is 0, anything but plain decimal digits is refused. */
function txUint(field: string, value: unknown, fallback: bigint, tx: unknown): bigint {
  if (value == null) return fallback
  const n = uint(value)
  if (n === null) refuse(`order tx ${field} ${JSON.stringify(value)} is not a decimal integer`, tx)
  return n
}

function addressWord(word: string, field: string, data: string): string {
  // A dirty upper 12 bytes would let our reading and the contract's disagree about the address.
  if (!word.startsWith('0'.repeat(24))) refuse(`exec ${field} is not a clean address word`, data)
  return '0x' + word.slice(24)
}

/**
 * Decode `AllowanceHolder.exec(operator, token, amount, target, data)` calldata. Only the
 * canonical ABI encoding is accepted — exact selector, the `bytes` offset right after the static
 * head, and no trailing data — so the fields read here are the fields the contract reads.
 */
export function decodeExec(data: string): ExecCall {
  const hex = String(data ?? '')
    .replace(/^0x/i, '')
    .toLowerCase()
  if (!/^[0-9a-f]*$/.test(hex) || hex.length < 8 + WORD * 6) {
    refuse('order calldata is not an AllowanceHolder exec call', data)
  }
  if (hex.slice(0, 8) !== EXEC_SELECTOR) {
    refuse(`order calldata selector 0x${hex.slice(0, 8)} is not exec (0x${EXEC_SELECTOR})`, data)
  }
  const word = (i: number) => hex.slice(8 + WORD * i, 8 + WORD * (i + 1))
  const offset = BigInt('0x' + word(4))
  const length = BigInt('0x' + word(5))
  const padded = ((length + 31n) / 32n) * 32n
  if (offset !== 5n * 32n || BigInt(hex.length) !== BigInt(8 + WORD * 6) + padded * 2n) {
    refuse('order calldata is not a canonically encoded exec call', data)
  }
  return {
    operator: addressWord(word(0), 'operator', data),
    token: addressWord(word(1), 'token', data),
    amount: BigInt('0x' + word(2)),
    target: addressWord(word(3), 'target', data),
  }
}

/** The cap on native `value` beyond the swapped amount: the caller's, else the chain default. */
function nativeFeeCap(ctx: OrderGuardContext): bigint | undefined {
  return ctx.maxNativeFee ?? DEFAULT_MAX_NATIVE_FEE[ctx.chain.toLowerCase()]
}

function assertContractCall(
  payload: Exclude<OrderPayload, { kind: 'btc' }>,
  ctx: OrderGuardContext
): void {
  const { tx } = payload
  // The wallet signs on its own chain; an order built for another one could not be indexed.
  if (payload.chain == null || !sameChain(payload.chain, ctx.chain)) {
    refuse(`order tx is for chain ${payload.chain}, but the route is from ${ctx.chain}`, tx)
  }
  const holder = allowanceHolderFor(ctx.chain)
  if (!holder) refuse(`no known AllowanceHolder for chain "${ctx.chain}"`)
  // EVM signers get `to` verbatim, so only the 0x form counts there; Tron accepts Base58 or 41-hex.
  const to = payload.kind === 'evm' && !EVM_ADDRESS.test(tx.to) ? null : toHexAddress(tx.to)
  if (to !== holder) {
    refuse(`order tx targets ${tx.to}, expected the AllowanceHolder at ${holder}`, tx)
  }

  const token = toHexAddress(ctx.token)
  if (!token) refuse(`cannot read source token ${ctx.token} as an address`)
  const exec = decodeExec(tx.data)
  if (exec.token !== token) {
    refuse(`order moves token ${exec.token}, but the swidge is from ${token}`, tx)
  }
  if (exec.amount > ctx.amount) {
    refuse(
      `order moves ${exec.amount} of the source token, more than fromTokenAmount ${ctx.amount}`,
      tx
    )
  }

  if (payload.kind === 'tron') {
    // An absent feeLimit is the one the Tron adapter builds the call with.
    const feeLimit = txUint('feeLimit', payload.tx.feeLimit, BigInt(DEFAULT_FEE_LIMIT_SUN), tx)
    if (feeLimit > MAX_TRON_FEE_LIMIT_SUN) {
      refuse(`order tx feeLimit ${feeLimit} sun is above ${MAX_TRON_FEE_LIMIT_SUN}`, tx)
    }
  }

  const value = txUint('value', tx.value, 0n, tx)
  // A native source pays its amount as `value`; anything beyond that is a fee, capped.
  const extra = token === ZERO ? value - ctx.amount : value
  if (extra <= 0n) return
  const cap = nativeFeeCap(ctx)
  if (cap === undefined) {
    refuse(
      `order tx sends ${extra} native base units on top of the swap and chain "${ctx.chain}" has ` +
        'no default cap: pass maxNativeFee',
      tx
    )
  }
  if (extra > cap) {
    refuse(
      `order tx sends ${extra} native base units on top of the swap, above maxNativeFee ${cap}`,
      tx
    )
  }
}

/**
 * An onramp's BTC amount comes from the quote (the order carries none), so it is checked before
 * create-order, and a quote it refuses leaves no orphaned order: it must equal `fromTokenAmount`.
 *
 * @param quote - The get-quote response, holding the onramp quote.
 * @param amount - The requested `fromTokenAmount`, in sats.
 * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the amount is not a plain decimal or differs.
 */
export function assertOnrampAmount(quote: GatewayQuoteV4, amount: bigint): void {
  const quoted = parseBaseUnits(
    'quote onramp.inputAmount.amount',
    quote.onramp?.inputAmount?.amount
  )
  assertSats(quoted, amount, quote)
}

function assertSats(quoted: bigint, amount: bigint, cause: unknown): void {
  if (quoted !== amount) {
    refuse(`the quote asks for ${quoted} sats, but fromTokenAmount is ${amount}`, cause)
  }
}

/**
 * Hold a create-order payload against what the caller asked for, before anything is signed.
 *
 * Approvals to the AllowanceHolder are unbounded, so the order transaction is what bounds a
 * swidge: a wrong or hostile create-order response must not be able to call another contract,
 * move another token, move more than `fromTokenAmount`, or attach more native value than a
 * messaging fee. On EVM and Tron the tx must be `AllowanceHolder.exec` on the pinned holder for
 * the source chain, moving the source token, at most `fromTokenAmount` of it, with native `value`
 * beyond the swapped amount capped by `maxNativeFee`. On an onramp, the BTC amount (taken from
 * the quote) must equal `fromTokenAmount`; the deposit address is per-order and cannot be pinned.
 *
 * The order must also be for the requested source chain, and a Tron order's `feeLimit` may not
 * exceed `MAX_TRON_FEE_LIMIT_SUN`. Every amount field must be plain decimal digits, so the value
 * checked here is the value the signer reads.
 *
 * EVM gas is not capped here. Unlike Tron's `feeLimit` it is not part of the order: the account
 * estimates it, so a hostile inner call can only make the tx expensive, not set its ceiling. The
 * WDK account's own `transactionMaxFee` bounds that (`gasLimit × maxFeePerGas`, checked before
 * signing), for every transaction it sends.
 *
 * The GatewayRouter (`exec`'s operator and target) is deliberately not pinned. It forwards the
 * pulled tokens to an arbitrary inner call (registry, OFT, aggregator…), so a hostile order could
 * misroute them through the real router just as well; what bounds the loss is the `token`/`amount`
 * the holder lets it pull, checked here. That bound rests on the holder refusing a token as
 * `target`: `exec` calls `target` as the holder, the spender of every unbounded approval, so a
 * `target` of `token.transferFrom(account, attacker, balance)` would move the whole approved
 * balance of any token, not one order's worth. 0x's AllowanceHolder rejects that confused deputy
 * (`_rejectIfERC20`, reverting `ConfusedDeputy()`), and every holder pinned in
 * `src/allowance-holder.ts` — the gateway's own on BOB and Tron included — carries the check
 * (verified against the deployed bytecode, 2026-11-10). A holder added to that table must too.
 *
 * @throws {GatewaySwidgeError} `VALIDATION_ERROR` if the payload does not match.
 */
export function assertOrderPayload(payload: OrderPayload, ctx: OrderGuardContext): void {
  if (payload.kind === 'btc') {
    assertSats(payload.amount, ctx.amount, payload)
    return
  }
  assertContractCall(payload, ctx)
}

// The adapter's pre-signing check requires `raw_data`, `raw_data_hex` and `txID` to agree,
// so these builders derive the latter two with tronweb's own serializer — no stub objects.
import { utils } from 'tronweb'
import { USDT_ETHEREUM, ZERO } from './gateway.js'
import { execData } from './exec.js'

// Real mainnet addresses — `toHex` rejects made-up Base58, and the adapter converts.
export const OWNER = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'
// The gateway's Tron AllowanceHolder — the order call target, and the approval spender.
export const REGISTRY = 'TAfbit1ENsRmtZbPQfYU3srURpfYuWYS7K'
export const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
export const SPENDER = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'

/** exec calldata moving 1 USDT (Tron). */
export const TRON_EXEC = execData({ token: USDT, amount: 1_000_000n })
/** Same, without `0x`, as it sits in a built Tron tx's `raw_data`. */
export const TRON_EXEC_HEX = TRON_EXEC.slice(2)
/** exec calldata moving `tronOfframpQuote`'s 50 USDT: the order call `buildTronTx()` builds by default. */
export const TRON_OFFRAMP_EXEC = execData({ token: USDT, amount: 50_000_000n })

const TIMESTAMP = Date.now()

const DEFAULT_WINDOW_MS = 5 * 60 * 1000

export interface TronTxOverrides {
  owner?: string
  to?: string
  data?: string
  callValue?: number
  feeLimit?: number
  timestamp?: number
  expiration?: number
  /** TRC-10 value riding along in the same contract; tronweb serializes both when set. */
  callTokenValue?: number
  tokenId?: number
  /** Free-form memo; a node that adds one changes the txID the account signs. */
  memo?: string
  /** Multisig permission the call would be routed through; 0/absent is the owner key. */
  permissionId?: number
}

export function buildTronTx(overrides: TronTxOverrides = {}) {
  const {
    owner = OWNER,
    to = REGISTRY,
    data = TRON_OFFRAMP_EXEC.slice(2),
    callValue = 0,
    feeLimit = 50_000_000,
    timestamp = TIMESTAMP,
    expiration = timestamp + DEFAULT_WINDOW_MS,
    callTokenValue,
    tokenId,
    memo,
    permissionId,
  } = overrides

  const raw_data = {
    contract: [
      {
        parameter: {
          value: {
            data,
            owner_address: utils.address.toHex(owner),
            contract_address: utils.address.toHex(to),
            call_value: callValue,
            ...(callTokenValue ? { call_token_value: callTokenValue } : {}),
            ...(tokenId ? { token_id: tokenId } : {}),
          },
          type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
        },
        type: 'TriggerSmartContract',
        ...(permissionId ? { Permission_id: permissionId } : {}),
      },
    ],
    ref_block_bytes: '1234',
    ref_block_hash: '0123456789abcdef',
    expiration,
    fee_limit: feeLimit,
    timestamp,
    ...(memo ? { data: memo } : {}),
  }

  const tx = { visible: false, txID: '', raw_data, raw_data_hex: '' }
  const pb = utils.transaction.txJsonToPb(tx)
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).toLowerCase()
  tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '').toLowerCase()
  return tx
}

export const BTC_RECIPIENT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

/** get-quote: 50 USDT on Tron → BTC, captured from mainnet (2026-11-09) for the `OWNER` account. */
export function tronOfframpQuote() {
  return {
    offramp: {
      srcChain: 'tron',
      tokenAddress: USDT,
      inputAmount: { amount: '50000000', address: USDT, chain: 'tron', usd: '49.94' },
      outputAmount: { amount: '66086', address: ZERO, chain: 'bitcoin', usd: '49.25' },
      totalFeeUsd: '0.50',
      feeBreakdown: {
        solverFee: { amount: '498', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        inclusionFee: { amount: '660', address: ZERO, chain: 'bitcoin', usd: '0.49' },
        protocolFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        affiliateFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        fastestFeeRate: '3',
      },
      sender: OWNER,
      recipient: BTC_RECIPIENT,
      slippage: 50,
      affiliates: [],
      txTo: REGISTRY,
      estimatedTimeInSecs: 648,
      priceImpact: '-0.0040',
      refundAddress: OWNER,
    },
  }
}

/**
 * create-order for `tronOfframpQuote`: a `tron`-tagged `GatewayTxData` for the call `buildTronTx()`
 * builds by default (`TRON_OFFRAMP_EXEC`, 50 TRX fee limit).
 */
export function tronOfframpOrder(tx: Record<string, string | undefined> = {}) {
  return {
    offramp: {
      order_id: 'order-tron',
      tx: {
        type: 'tron',
        to: REGISTRY,
        data: TRON_OFFRAMP_EXEC,
        value: '0',
        chain: 'tron',
        feeLimit: '50000000',
        ...tx,
      },
    },
  }
}

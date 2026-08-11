// Builders for realistic tronweb responses.
//
// The adapter validates a built transaction before it reaches the signer, so a stub
// object is no longer enough: `raw_data`, `raw_data_hex` and `txID` have to agree.
// These helpers derive the latter two from the former with tronweb's own serializer,
// which is exactly what the adapter re-checks.
import { utils } from 'tronweb'

// Real mainnet addresses — `toHex` rejects made-up Base58, and the adapter converts.
export const OWNER = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'
export const REGISTRY = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
export const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
export const SPENDER = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'

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
    data = 'abcdef',
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

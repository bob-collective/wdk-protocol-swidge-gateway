import { describe, test, expect } from 'vitest'
import { toEvmAddress } from '../src/address.js'

const TRON_OWNER = 'TSzpAEmPDG1LshvrT1btgU8QPd7cXQXDtG'
const TRON_OWNER_HEX = '0xbac7e7260eac150bddc4b6d87b54a6a178853b0f'

describe('toEvmAddress', () => {
  test('converts a Tron Base58Check address to its 0x-hex form', () => {
    expect(toEvmAddress(TRON_OWNER)).toBe(TRON_OWNER_HEX)
  })

  test('passes EVM addresses through unchanged, checksum casing included', () => {
    const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    expect(toEvmAddress(usdt)).toBe(usdt)
  })

  test('passes bech32 BTC addresses through unchanged', () => {
    const btc = 'bc1q4qzrf00t40tnqlc374s07dnnywltz0pt2aqmya'
    expect(toEvmAddress(btc)).toBe(btc)
  })

  test('rejects a Tron-shaped address with a broken checksum', () => {
    // Last character flipped: still `T` + 33 Base58 chars, but the checksum no longer matches.
    const corrupt = TRON_OWNER.slice(0, -1) + (TRON_OWNER.endsWith('G') ? 'H' : 'G')
    expect(() => toEvmAddress(corrupt)).toThrow(/not a valid Tron address/)
  })

  test('leaves a non-Tron Base58Check address alone', () => {
    // A P2PKH mainnet BTC address decodes cleanly under the same Base58Check scheme but
    // carries version 0x00, not Tron's 0x41. It must survive untouched, not convert.
    const p2pkh = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
    expect(toEvmAddress(p2pkh)).toBe(p2pkh)
  })
})

/* eslint-env jest */
'use strict'

import { getAdapter } from '../src/chain-adapters/registry.js'

test('returns bitcoin + evm adapters', () => {
  expect(getAdapter('bitcoin').family).toBe('bitcoin')
  expect(getAdapter('evm').family).toBe('evm')
})

test('tron source send throws with issue link', async () => {
  await expect(getAdapter('tron').send({}, {})).rejects.toThrow(/wdk-wallet-tron#48|destination-only/i)
})

test('solana unsupported in v1', () => {
  expect(() => getAdapter('solana')).toThrow(/not supported/i)
})

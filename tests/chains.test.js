/* eslint-env jest */
'use strict'

import { chainFamily, detectVariant } from '../src/chains.js'

test('chainFamily classifies chains', () => {
  expect(chainFamily('bitcoin')).toBe('bitcoin')
  expect(chainFamily('tron')).toBe('tron')
  expect(chainFamily('base')).toBe('evm')
})

test('detectVariant by BTC side', () => {
  expect(detectVariant({ srcFamily: 'bitcoin', dstFamily: 'evm' })).toBe('onramp')
  expect(detectVariant({ srcFamily: 'evm', dstFamily: 'bitcoin' })).toBe('offramp')
  expect(detectVariant({ srcFamily: 'evm', dstFamily: 'evm' })).toBe('tokenSwap')
})

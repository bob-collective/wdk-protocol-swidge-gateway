import { describe, test, expect } from 'vitest'
import { GatewaySwidge, GatewayClient } from '../src/index.js'

describe('bare smoke', () => {
  test('constructs with injected http (no global fetch needed)', () => {
    const http = { request: async () => ({ status: 200, body: [] }) }
    const sw = new GatewaySwidge({}, { fromChain: 'base', apiKey: 'k'.repeat(32), http })
    expect(sw).toBeInstanceOf(GatewaySwidge)
    expect(new GatewayClient({ http })).toBeTruthy()
  })
})

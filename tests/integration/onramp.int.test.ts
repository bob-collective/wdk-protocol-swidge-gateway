const RUN = process.env.GATEWAY_INT === '1'
;(RUN ? describe : describe.skip)('gateway integration (testnet)', () => {
  test('quoteSwidge returns a live quote', async () => {
    const { GatewaySwidge } = await import('../../src/index.js')
    const sw = new GatewaySwidge(
      {},
      { apiUrl: process.env.GATEWAY_TEST_URL, fromChain: 'bitcoin' }
    )
    const q = await sw.quoteSwidge({
      fromToken: 'BTC',
      toToken: process.env.TEST_TOKEN as string,
      toChain: process.env.TEST_CHAIN,
      recipient: process.env.TEST_RECIPIENT,
      fromTokenAmount: 100000n,
    })
    expect(q.toTokenAmount).toBeGreaterThan(0n)
  })
})

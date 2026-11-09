// Gateway V4 wire responses captured from mainnet (2026-11-09), trimmed to the fields we read.

export const ZERO = '0x0000000000000000000000000000000000000000'
export const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const USDT0_ARBITRUM = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
export const USDT_ETHEREUM = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
export const ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'

/** get-quote: 100 USDT on Base → BTC. Solver fee is USDT on Ethereum, inclusion fee BTC sats. */
export function offrampQuote() {
  return {
    offramp: {
      srcChain: 'base',
      tokenAddress: USDT_BASE,
      inputAmount: { amount: '100000000', address: USDT_BASE, chain: 'base', usd: '99.82' },
      outputAmount: { amount: '133315', address: ZERO, chain: 'bitcoin', usd: '98.71' },
      totalFeeUsd: '0.66',
      feeBreakdown: {
        solverFee: { amount: '995', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        inclusionFee: { amount: '880', address: ZERO, chain: 'bitcoin', usd: '0.65' },
        protocolFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        affiliateFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        fastestFeeRate: '4',
      },
      sender: '0xsender',
      recipient: 'bc1qrcpt',
      slippage: 50,
      affiliates: [],
      txTo: ALLOWANCE_HOLDER,
      estimatedTimeInSecs: 648,
      priceImpact: '-0.0045',
      refundAddress: '0xsender',
    },
  }
}

/** create-order for `offrampQuote`. */
export function offrampOrder() {
  return {
    offramp: {
      order_id: 'order-offramp',
      tx: { type: 'evm', to: ALLOWANCE_HOLDER, data: '0x2213bc0b', value: '0', chain: 'base' },
    },
  }
}

/**
 * get-quote: 100 USDT on Base → USDT0 on Arbitrum. Token swaps carry no fee breakdown. The quote
 * echoes the request, so `dstToken`/`recipient` follow the route under test.
 */
export function tokenSwapQuote(
  srcChain = 'base',
  dstChain = 'arbitrum',
  { dstToken = USDT0_ARBITRUM, recipient = '0xrcpt' } = {}
) {
  return {
    tokenSwap: {
      srcChain,
      dstChain,
      inputAmount: { amount: '100000000', address: USDT_BASE, chain: srcChain, usd: '99.82' },
      outputAmount: { amount: '99797888', address: dstToken, chain: dstChain, usd: '99.61' },
      estimatedTimeInSecs: 11,
      sender: '0xsender',
      recipient,
      slippage: 150,
      fees: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: null },
      txTo: ALLOWANCE_HOLDER,
      priceImpact: '-0.0020',
      affiliate: null,
      refundAddress: '0xsender',
    },
  }
}

/** create-order for `tokenSwapQuote`. */
export function tokenSwapOrder() {
  return {
    tokenSwap: {
      order_id: 'order-swap',
      tx: { type: 'evm', to: ALLOWANCE_HOLDER, data: '0x2213bc0b', value: '0', chain: 'base' },
    },
  }
}

export const BTC_SENDER = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
export const EVM_RECIPIENT = '0x000000000000000000000000000000000000dEaD'
/** A taproot deposit address, as create-order hands them out. */
export const DEPOSIT_ADDRESS = 'bc1pk09yz29n9sslvzat09hnjd5se3u3pdxc2tl3ec7am6uc6q7htrdqv0cleg'

/** get-quote: 50,000 sats → USDT on Base. The onramp echoes slippage as a string. */
export function onrampQuote() {
  return {
    onramp: {
      inputAmount: { amount: '50000', address: ZERO, chain: 'bitcoin', usd: '37.26' },
      outputAmount: { amount: '37141289', address: USDT_BASE, chain: 'base', usd: '37.06' },
      sender: BTC_SENDER,
      recipient: EVM_RECIPIENT,
      slippage: '50',
      feeBreakdown: {
        solverFee: { amount: '373', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        protocolFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        affiliateFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
        executionFee: { amount: '195982', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0.20' },
        layerzeroFee: { amount: '0', address: USDT_ETHEREUM, chain: 'ethereum', usd: '0' },
      },
      dstChain: 'base',
      dstToken: USDT_BASE,
      estimatedTimeInSecs: 616,
      priceImpact: '-0.0002' as string | null,
    },
  }
}

/** create-order for `onrampQuote`: the deposit address only — the amount comes from the quote. */
export function onrampOrder() {
  return { onramp: { order_id: 'order-onramp', address: DEPOSIT_ADDRESS } }
}

/** get-order: a completed BTC → USDC-on-Ethereum onramp. */
export function completedOrder() {
  return {
    id: 'f87cce13-a0da-4c2c-b0cf-773802f94b7e',
    timestamp: 1794205170,
    srcInfo: {
      chain: 'bitcoin',
      token: ZERO,
      amount: '33624',
      usd: '24.99',
      txHash: 'd70ffadb43a9118f94d82fcf6cf7d5a05c688f6ebed4500144e2ce732effad4d',
    },
    dstInfo: {
      chain: 'ethereum',
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amount: '24897035',
      usd: '24.89',
    },
    status: {
      success: {
        received_tokens: [
          {
            token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            amount: '24901436',
            chain: 'ethereum',
            usd: '24.89',
            txHash: '0xddfa5650b89a496aa672fae2b48e709982617daf3dc1090f48e28899c58876e5',
          },
        ],
      },
    },
    estimatedTimeInSecs: null,
    depositAddress: 'bc1pk09yz29n9sslvzat09hnjd5se3u3pdxc2tl3ec7am6uc6q7htrdqv0cleg',
  }
}

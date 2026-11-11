/**
 * Bare runtime smoke test: loads the package under Bare through its `bare` export condition
 * (`bare.js` → `dist/` with the `bare-node-runtime` import map) and drives a gateway call through
 * the default fetch transport, so a Node-only builtin or global fails here rather than in an app.
 * No network: the global `fetch` is stubbed. Run with `pnpm test:bare`, which builds `dist/` first.
 */
import GatewaySwidge, {
  BTC,
  ERR,
  GatewayClient,
  GatewaySwidgeError,
  buildTronApproval,
} from '@gobob/wdk-protocol-swidge-gateway'

function check(ok, what) {
  if (!ok) throw new Error(`bare smoke: ${what}`)
}

check(typeof Bare === 'object', 'not running under Bare')
check(typeof GatewaySwidge === 'function', 'default export is not GatewaySwidge')
check(typeof GatewayClient === 'function', 'GatewayClient is not exported')
check(typeof GatewaySwidgeError === 'function', 'GatewaySwidgeError is not exported')
check(typeof buildTronApproval === 'function', 'buildTronApproval is not exported')
check(BTC === 'BTC' && ERR.HTTP === 'GATEWAY_HTTP_ERROR', 'BTC / ERR constants')

const ZERO = '0x0000000000000000000000000000000000000000'
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
const ROUTES = [
  { srcChain: 'bitcoin', dstChain: 'base', srcToken: ZERO, dstToken: USDT_BASE },
  { srcChain: 'base', dstChain: 'bitcoin', srcToken: USDT_BASE, dstToken: ZERO },
]

// The default transport runs on the globals bare-node-runtime provides. Stub fetch only, so the
// rest of the request path runs for real.
const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url, method: init.method })
  return { status: 200, text: async () => JSON.stringify(ROUTES) }
}

const sw = new GatewaySwidge(undefined, { fromChain: 'base' })
const chains = await sw.getSupportedChains()
const tokens = await sw.getSupportedTokens({ fromChain: 'base' })

check(
  requests.length === 2 &&
    requests.every(
      (r) => r.url === 'https://gateway-api-mainnet.gobob.xyz/v4/get-routes' && r.method === 'GET'
    ),
  `unexpected requests: ${JSON.stringify(requests.map((r) => [r.method, r.url]))}`
)
check(
  JSON.stringify(chains.map((c) => [c.id, c.type])) === '[["bitcoin","utxo"],["base","evm"]]',
  `unexpected chains: ${JSON.stringify(chains)}`
)
check(
  JSON.stringify(tokens.map((t) => [t.chain, t.symbol, t.decimals])) === '[["base","USDT",6]]',
  `unexpected tokens: ${JSON.stringify(tokens)}`
)

console.log(`bare smoke: ok (Bare ${Bare.version})`)

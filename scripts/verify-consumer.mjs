/**
 * Consumer-tree regression guard for WDK core registration.
 *
 * WDK core's `registerProtocol` dispatches on `Protocol.prototype instanceof SwidgeProtocol`
 * and has no `else` branch — a class that fails the check is dropped silently, and the failure
 * only surfaces later as "No swidge protocol registered for label: ...".
 *
 * That check compares against the copy of `@tetherto/wdk-wallet` that *core* resolves. If we ship
 * our own copy (a regular dependency pinned to a version core cannot dedupe with), two copies land
 * on disk, the base class has two identities, and every consumer using the documented core wiring
 * breaks. Hence `@tetherto/wdk-wallet` is a peerDependency.
 *
 * The in-repo test suite cannot catch this: our dev tree only ever has one copy, so `instanceof`
 * passes trivially. This check must run against a packed tarball in a real consumer install.
 *
 * It runs twice: once against the latest core, and once with `@tetherto/wdk-wallet` held at the
 * lowest version our peer range admits. The dev tree only ever sees the devDependency version, so
 * without the second run a peer floor bump (or a use of an API newer than the floor) ships unseen.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' })

const repo = process.cwd()

const peerRange = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).peerDependencies[
  '@tetherto/wdk-wallet'
]
const peerFloor = /^>=\s*(\S+)/.exec(peerRange)?.[1]
if (!peerFloor)
  throw new Error(
    `cannot read a ">=" floor from the @tetherto/wdk-wallet peer range "${peerRange}"`
  )

// The floor run pins core and the EVM wallet to releases whose own `@tetherto/wdk-wallet` dependency
// admits the floor, so npm dedupes core's copy down to it. Bump these alongside the peer floor.
const scenarios = [
  { label: 'latest', deps: ['@tetherto/wdk', '@tetherto/wdk-wallet-evm'] },
  {
    label: `peer floor ${peerFloor}`,
    deps: [
      `@tetherto/wdk-wallet@${peerFloor}`,
      '@tetherto/wdk@1.0.0-beta.14',
      '@tetherto/wdk-wallet-evm@1.0.0-beta.15',
    ],
    wallet: peerFloor,
  },
]

const check = `import assert from 'node:assert/strict'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { GatewaySwidge } from '@gobob/wdk-protocol-swidge-gateway'

const wdk = new WDK('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
  .registerWallet('ethereum', WalletManagerEvm, { chainId: 1, provider: 'https://ethereum-rpc.publicnode.com' })
  .registerProtocol('ethereum', 'gateway', GatewaySwidge, { fromChain: 'ethereum' })

const account = await wdk.getAccount('ethereum', 0)

// Throws "No swidge protocol registered" if core silently dropped us at registerProtocol.
const swidge = account.getSwidgeProtocol('gateway')
assert.equal(swidge.constructor.name, 'GatewaySwidge')
assert.ok(typeof swidge.quoteSwidge === 'function')

wdk.dispose()
`

// `npm pack` ships whatever is in dist/ (there is no prepack hook), so the caller is
// responsible for building first — see the `verify:consumer` script. Tracked out here so a
// failed run cleans up its tarball too, rather than leaving one in the repo root.
let tarball

try {
  tarball = run('npm', ['pack', '--silent'], repo).trim().split('\n').pop()

  for (const { label, deps, wallet } of scenarios) {
    const dir = mkdtempSync(join(tmpdir(), 'wdk-consumer-'))
    try {
      run('npm', ['init', '-y'], dir)
      run('npm', ['pkg', 'set', 'type=module'], dir)
      run('npm', ['install', '--silent', join(repo, tarball), ...deps], dir)
      if (wallet) {
        // Core's own copy is the one registerProtocol checks against, so that's the one that
        // must be the floor. (`package.json` isn't in wdk-wallet's exports, so read it off disk.)
        const nested = join(dir, 'node_modules/@tetherto/wdk/node_modules/@tetherto/wdk-wallet')
        const pkg = join(
          existsSync(nested) ? nested : join(dir, 'node_modules/@tetherto/wdk-wallet'),
          'package.json'
        )
        const resolved = JSON.parse(readFileSync(pkg, 'utf8')).version
        if (resolved !== wallet)
          throw new Error(`core resolved @tetherto/wdk-wallet@${resolved}, expected ${wallet}`)
      }
      writeFileSync(join(dir, 'check.mjs'), check)
      run('node', ['check.mjs'], dir)
      console.log(
        `ok (${label}): GatewaySwidge survives WDK core registerProtocol in a consumer tree`
      )
    } catch (err) {
      err.message = `[${label}] ${err.message}`
      throw err
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
} catch (err) {
  console.error('FAILED: GatewaySwidge is not registrable through WDK core.')
  console.error(err.stdout?.toString() || '', err.stderr?.toString() || '', err.message)
  process.exitCode = 1
} finally {
  if (tarball) rmSync(join(repo, tarball), { force: true })
}

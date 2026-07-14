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
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' })

const repo = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'wdk-consumer-'))

// `npm pack` ships whatever is in dist/ (there is no prepack hook), so the caller is
// responsible for building first — see the `verify:consumer` script. Tracked out here so a
// failed run cleans up its tarball too, rather than leaving one in the repo root.
let tarball

try {
  tarball = run('npm', ['pack', '--silent'], repo).trim().split('\n').pop()

  run('npm', ['init', '-y'], dir)
  run('npm', ['pkg', 'set', 'type=module'], dir)
  run('npm', ['install', '--silent', join(repo, tarball), '@tetherto/wdk', '@tetherto/wdk-wallet-evm'], dir)

  writeFileSync(
    join(dir, 'check.mjs'),
    `import assert from 'node:assert/strict'
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
console.log('ok: GatewaySwidge survives WDK core registerProtocol in a consumer tree')
`
  )

  process.stdout.write(run('node', ['check.mjs'], dir))
} catch (err) {
  console.error('FAILED: GatewaySwidge is not registrable through WDK core.')
  console.error(err.stdout?.toString() || '', err.stderr?.toString() || '', err.message)
  process.exitCode = 1
} finally {
  if (tarball) rmSync(join(repo, tarball), { force: true })
  rmSync(dir, { recursive: true, force: true })
}

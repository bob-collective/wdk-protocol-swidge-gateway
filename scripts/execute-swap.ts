/**
 * execute-swap.ts
 *
 * Phase-driven real-funds swap harness for the WDK Gateway swidge module.
 * BROADCASTS real mainnet transactions — correctness matters.
 *
 * Required env:
 *   TEST_SEED   — BIP-39 mnemonic (injected from 1Password in CI)
 *
 * Optional env:
 *   EVM_RPC_URL  — Ethereum JSON-RPC URL (default: https://ethereum-rpc.publicnode.com)
 *   TRON_RPC_URL — Tron full-node URL (default: https://tron.api.pocket.network)
 *   PHASE        — onramp | tron-onramp | offramp | tron-offramp | status
 *   AMOUNT       — integer string: sats for either onramp, USDT 6-decimal units for either offramp
 *   ORDER_ID     — gateway order ID (required for status phase)
 *
 * Run (after pnpm build):
 *   pnpm execute-swap
 *
 * NEVER prints the seed.
 */

const TEST_SEED = process.env.TEST_SEED
const EVM_RPC_URL = process.env.EVM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'
const TRON_RPC_URL = process.env.TRON_RPC_URL ?? 'https://tron.api.pocket.network'
const PHASE = process.env.PHASE
const AMOUNT = process.env.AMOUNT
const ORDER_ID = process.env.ORDER_ID

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)']

const PHASES = ['onramp', 'tron-onramp', 'offramp', 'tron-offramp', 'status'] as const
type Phase = (typeof PHASES)[number]

const POLL_INTERVAL_MS = 10_000
const MAX_POLLS = 30
const POLL_TIMEOUT_MIN = (MAX_POLLS * POLL_INTERVAL_MS) / 60_000

function fail(message: string): never {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function isPhase(value: string | undefined): value is Phase {
  return value !== undefined && (PHASES as readonly string[]).includes(value)
}

if (!TEST_SEED) {
  fail('TEST_SEED is not set. Inject it via 1Password or export it manually.')
}

if (!isPhase(PHASE)) {
  fail(`PHASE must be one of: ${PHASES.join(' | ')} (got: ${String(PHASE)})`)
}

function requireAmount(unit: string): bigint {
  if (!AMOUNT) fail(`AMOUNT (${unit}) is required for ${PHASE} phase`)
  return BigInt(AMOUNT)
}

// Dynamic imports — only loaded after seed guard so the error message is clean.
const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')
const { default: WalletManagerTron } = await import('@tetherto/wdk-wallet-tron')
const { GatewaySwidge, buildTronApproval } = await import('../dist/index.js')

type Swidge = InstanceType<typeof GatewaySwidge>
type SwidgeResult = Awaited<ReturnType<Swidge['swidge']>>
type RequiredApproval = NonNullable<Awaited<ReturnType<Swidge['getRequiredApproval']>>>

const btcWallet = new WalletManagerBtc(TEST_SEED, { network: 'bitcoin' })
const btcAccount = await btcWallet.getAccount(0)
const btcAddress: string = await btcAccount.getAddress()

const evmWallet = new WalletManagerEvm(TEST_SEED, { provider: EVM_RPC_URL })
const evmAccount = await evmWallet.getAccount(0)
const evmAddress: string = await evmAccount.getAddress()

const tronWallet = new WalletManagerTron(TEST_SEED, { provider: TRON_RPC_URL })
const tronAccount = await tronWallet.getAccount(0)
const tronAddress: string = await tronAccount.getAddress()

async function runPhase(name: Phase, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (err) {
    console.error(`${name} failed:`, err)
    process.exit(1)
  }
}

function logApprovalRequired(approval: RequiredApproval): void {
  console.log(
    `Approval required: token=${approval.token}  spender=${approval.spender}  amount=${String(approval.amount)}`
  )
}

function logApprovalTx(result: { hash: string; fee?: bigint }): void {
  // `TransactionResult.fee` is typed as required, but this script never assumes it.
  const fee = result.fee === undefined ? 'n/a' : String(result.fee)
  console.log(`Approval tx submitted: hash=${result.hash}  fee=${fee}`)
}

function logSwidgeResult(txLabel: string, result: SwidgeResult): void {
  console.log(`ORDER_ID=${result.id}`)
  console.log(`${txLabel}=${result.hash}`)
  console.log(`toTokenAmount="${String(result.toTokenAmount)}"`)
  console.log(`fromTokenAmount="${String(result.fromTokenAmount)}"`)
}

interface TronTrx {
  getTransaction(id: string): Promise<unknown>
}

function requireTronTrx(): TronTrx {
  const { _tronWeb: tronWeb } = tronAccount as unknown as {
    _tronWeb?: { trx?: Partial<TronTrx> }
  }
  if (typeof tronWeb?.trx?.getTransaction !== 'function') {
    fail('the Tron account has no tronweb provider, so the broadcast cannot be confirmed')
  }
  return tronWeb.trx as TronTrx
}

async function assertTronBroadcast(hash: string): Promise<void> {
  const trx = requireTronTrx()
  const deadline = Date.now() + 20_000
  let lastError: unknown
  for (;;) {
    try {
      await trx.getTransaction(hash)
      return
    } catch (err) {
      lastError = err
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  console.error('Broadcast lookup failed with:', lastError)
  fail(`Tron node does not know tx ${hash} 20 s after broadcast — the node rejected it.`)
}

/** `probe` reports its own log detail, so each chain prints what it actually measured. */
async function waitForApproval(
  probe: () => Promise<{ done: boolean; detail: string }>
): Promise<void> {
  console.log(
    `Polling for approval to take effect (every ${POLL_INTERVAL_MS / 1000} s, max ${POLL_TIMEOUT_MIN} min)...`
  )
  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const { done, detail } = await probe()
    console.log(`  [poll ${attempt}/${MAX_POLLS}] ${detail}`)
    if (done) {
      console.log('Approval confirmed on-chain.')
      return
    }
  }
  fail(`Approval not mined within ${POLL_TIMEOUT_MIN} minutes. Aborting to avoid failed swap.`)
}

switch (PHASE) {
  // BTC → USDT@Ethereum. Broadcasts a real BTC transaction. Irreversible.
  case 'onramp': {
    const fromTokenAmount = requireAmount('sats, integer')
    console.log(
      `PHASE=onramp  fromTokenAmount=${AMOUNT} sats  recipient=${evmAddress}  refundAddress=${btcAddress}`
    )

    await runPhase('onramp', async () => {
      const sw = new GatewaySwidge(btcAccount, { fromChain: 'bitcoin' })
      const result = await sw.swidge({
        fromToken: 'BTC',
        toToken: USDT,
        toChain: 'ethereum',
        recipient: evmAddress,
        fromTokenAmount,
        refundAddress: btcAddress,
      })
      logSwidgeResult('BTC_TXID', result)
    })
    break
  }

  // BTC → USDT@Tron. Broadcasts a real BTC transaction. Irreversible.
  case 'tron-onramp': {
    const fromTokenAmount = requireAmount('sats, integer')
    console.log(
      `PHASE=tron-onramp  fromTokenAmount=${AMOUNT} sats  recipient=${tronAddress}  refundAddress=${btcAddress}`
    )

    await runPhase('tron-onramp', async () => {
      const sw = new GatewaySwidge(btcAccount, { fromChain: 'bitcoin' })
      const result = await sw.swidge({
        fromToken: 'BTC',
        toToken: USDT_TRON,
        toChain: 'tron',
        recipient: tronAddress,
        fromTokenAmount,
        refundAddress: btcAddress,
      })
      logSwidgeResult('BTC_TXID', result)
    })
    break
  }

  // USDT@Ethereum → BTC. Broadcasts a real EVM transaction. Irreversible.
  case 'offramp': {
    const fromTokenAmount = requireAmount('USDT 6-decimal units, integer')
    console.log(
      `PHASE=offramp  fromTokenAmount=${AMOUNT} (USDT 6dp)  recipient=${btcAddress}  refundAddress=${evmAddress}`
    )

    await runPhase('offramp', async () => {
      const sw = new GatewaySwidge(evmAccount, { fromChain: 'ethereum' })
      const opts = {
        fromToken: USDT,
        toToken: 'BTC',
        toChain: 'bitcoin',
        recipient: btcAddress,
        fromTokenAmount,
        refundAddress: evmAddress,
      }

      const approval = await sw.getRequiredApproval(opts)
      if (approval === null) {
        console.log('No approval required (allowance already sufficient).')
      } else {
        logApprovalRequired(approval)
        logApprovalTx(await evmAccount.approve(approval))
        await waitForApproval(async () => {
          const allowance = await evmAccount.getAllowance(approval.token, approval.spender)
          return {
            done: allowance >= approval.amount,
            detail: `allowance=${String(allowance)}  required=${String(approval.amount)}`,
          }
        })
      }

      const result = await sw.swidge(opts)
      logSwidgeResult('EVM_TXID', result)
    })
    break
  }

  // USDT@Tron → BTC. Broadcasts a real Tron transaction. Irreversible.
  // The approval goes out via buildTronApproval — WalletAccountTron has no approve().
  case 'tron-offramp': {
    const fromTokenAmount = requireAmount('USDT 6-decimal units, integer')
    console.log(
      `PHASE=tron-offramp  fromTokenAmount=${AMOUNT} (USDT 6dp)  sender=${tronAddress}  recipient=${btcAddress}  refundAddress=${tronAddress}`
    )

    await runPhase('tron-offramp', async () => {
      const sw = new GatewaySwidge(tronAccount, { fromChain: 'tron' })
      const opts = {
        fromToken: USDT_TRON,
        toToken: 'BTC',
        toChain: 'bitcoin',
        recipient: btcAddress,
        fromTokenAmount,
        refundAddress: tronAddress,
      }

      const [trxBalance, usdtBalance] = await Promise.all([
        tronAccount.getBalance(),
        tronAccount.getTokenBalance(USDT_TRON),
      ])
      console.log(`Tron balances: TRX=${String(trxBalance)} sun  USDT=${String(usdtBalance)} (6dp)`)
      if (BigInt(usdtBalance) < fromTokenAmount) {
        fail(
          `USDT-TRC20 balance ${String(usdtBalance)} is below the ${String(fromTokenAmount)} to swap. Fund ${tronAddress}.`
        )
      }
      if (BigInt(trxBalance) === 0n) {
        fail(
          `TRX balance is 0, so ${tronAddress} is unactivated and can pay for neither energy nor bandwidth. Fund it with ~30 TRX.`
        )
      }

      const approval = await sw.getRequiredApproval(opts)
      if (approval === null) {
        console.log('No approval required (allowance already sufficient).')
      } else {
        logApprovalRequired(approval)
        const approvalCall = buildTronApproval(approval)
        const { fee: approvalFee } = await tronAccount.quoteSendTransaction(approvalCall)
        if (BigInt(trxBalance) < BigInt(approvalFee)) {
          fail(
            `TRX balance ${String(trxBalance)} sun cannot cover the ${String(approvalFee)} sun approval fee. Fund ${tronAddress}.`
          )
        }
        const approvalTx = await tronAccount.sendTransaction(approvalCall)
        logApprovalTx(approvalTx)
        await assertTronBroadcast(approvalTx.hash)
        // The spender is cached, so re-checking costs no extra gateway orders.
        await waitForApproval(async () => {
          const still = await sw.getRequiredApproval(opts)
          return { done: still === null, detail: `approvalStillRequired=${still !== null}` }
        })
      }

      const result = await sw.swidge(opts)
      logSwidgeResult('TRON_TXID', result)
    })
    break
  }

  // Read order status + wallet balances. Read-only, no tx.
  case 'status': {
    if (!ORDER_ID) fail('ORDER_ID is required for status phase')

    try {
      // Status lookup is read-only; any account works — use EVM for convenience.
      const sw = new GatewaySwidge(evmAccount, { fromChain: 'ethereum' })
      console.log(JSON.stringify(await sw.getSwidgeStatus(ORDER_ID), null, 2))
    } catch (err) {
      console.error(`status failed ORDER_ID=${ORDER_ID}:`, err)
      process.exit(1)
    }

    // Balances are supplementary: a failed lookup must not mask the status above.
    try {
      const { JsonRpcProvider, Contract } = await import('ethers')
      const usdt = new Contract(USDT, USDT_BALANCE_ABI, new JsonRpcProvider(EVM_RPC_URL))
      console.log(`EVM address: ${evmAddress}`)
      console.log(`USDT balance (6dp): ${String(await usdt.balanceOf(evmAddress))}`)
      console.log(`BTC address: ${btcAddress}`)
    } catch (err) {
      console.warn('EVM balance lookup failed:', err)
    }

    try {
      console.log(`Tron address: ${tronAddress}`)
      console.log(
        `USDT@tron balance (6dp): ${String(await tronAccount.getTokenBalance(USDT_TRON))}`
      )
      console.log(`TRX balance (sun): ${String(await tronAccount.getBalance())}`)
    } catch (err) {
      console.warn('Tron balance lookup failed:', err)
    }
    break
  }
}

export {}

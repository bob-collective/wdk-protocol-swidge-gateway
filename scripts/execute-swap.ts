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
 *   EVM_RPC_URL — Ethereum JSON-RPC URL (default: https://ethereum-rpc.publicnode.com)
 *   PHASE       — onramp | offramp | status
 *   AMOUNT      — integer string: sats for onramp, USDT 6-decimal units for offramp
 *   ORDER_ID    — gateway order ID (required for status phase)
 *
 * Run (after pnpm build):
 *   pnpm execute-swap
 *
 * NEVER prints the seed.
 */

const TEST_SEED = process.env.TEST_SEED
const EVM_RPC_URL = process.env.EVM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'
const PHASE = process.env.PHASE
const AMOUNT = process.env.AMOUNT
const ORDER_ID = process.env.ORDER_ID

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

if (!TEST_SEED) {
  console.error('ERROR: TEST_SEED is not set. Inject it via 1Password or export it manually.')
  process.exit(1)
}

if (!PHASE || !['onramp', 'offramp', 'status'].includes(PHASE)) {
  console.error('ERROR: PHASE must be one of: onramp | offramp | status (got: ' + String(PHASE) + ')')
  process.exit(1)
}

// Dynamic imports — only loaded after seed guard so the error message is clean.
const { default: WalletManagerBtc } = await import('@tetherto/wdk-wallet-btc')
const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')
const { GatewaySwidge } = await import('../dist/index.js')

// Derive both accounts from the same seed (account index 0 for both chains).
const btcWallet = new WalletManagerBtc(TEST_SEED, { network: 'bitcoin' })
const btcAccount = await btcWallet.getAccount(0)
const btcAddress: string = await btcAccount.getAddress()

const evmWallet = new WalletManagerEvm(TEST_SEED, { provider: EVM_RPC_URL })
const evmAccount = await evmWallet.getAccount(0)
const evmAddress: string = await evmAccount.getAddress()

// ---------------------------------------------------------------------------
// PHASE: onramp — BTC → USDT@Ethereum
// Broadcasts a real BTC transaction. Irreversible.
// ---------------------------------------------------------------------------
if (PHASE === 'onramp') {
  if (!AMOUNT) {
    console.error('ERROR: AMOUNT (sats, integer) is required for onramp phase')
    process.exit(1)
  }
  console.log(`PHASE=onramp  fromTokenAmount=${AMOUNT} sats  recipient=${evmAddress}  refundAddress=${btcAddress}`)

  let orderId: string | undefined
  try {
    const sw = new GatewaySwidge(btcAccount, { fromChain: 'bitcoin' })
    const r = await sw.swidge({
      fromToken: 'BTC',
      toToken: USDT,
      toChain: 'ethereum',
      recipient: evmAddress,
      fromTokenAmount: BigInt(AMOUNT),
      refundAddress: btcAddress,
    })
    orderId = r.id
    console.log(`ORDER_ID=${r.id}`)
    console.log(`BTC_TXID=${r.hash}`)
    console.log(`toTokenAmount="${String(r.toTokenAmount)}"`)
    console.log(`fromTokenAmount="${String(r.fromTokenAmount)}"`)
  } catch (err) {
    console.error(`onramp failed${orderId !== undefined ? ` ORDER_ID=${orderId}` : ''}:`, err)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// PHASE: offramp — USDT@Ethereum → BTC
// Checks + waits for ERC-20 approval, then broadcasts EVM tx. Irreversible.
// ---------------------------------------------------------------------------
if (PHASE === 'offramp') {
  if (!AMOUNT) {
    console.error('ERROR: AMOUNT (USDT 6-decimal units, integer) is required for offramp phase')
    process.exit(1)
  }
  console.log(`PHASE=offramp  fromTokenAmount=${AMOUNT} (USDT 6dp)  recipient=${btcAddress}  refundAddress=${evmAddress}`)

  let orderId: string | undefined
  try {
    const sw = new GatewaySwidge(evmAccount, { fromChain: 'ethereum' })
    const opts = {
      fromToken: USDT,
      toToken: 'BTC',
      toChain: 'bitcoin',
      recipient: btcAddress,
      fromTokenAmount: BigInt(AMOUNT),
      refundAddress: evmAddress,
    }

    // Check required ERC-20 approval before sending.
    const approval = await sw.getRequiredApproval(opts)
    if (approval !== null) {
      console.log(
        `Approval required: token=${approval.token}  spender=${approval.spender}  amount=${String(approval.amount)}`
      )
      const approvalResult = await (evmAccount as { approve: (args: { token: string; spender: string; amount: bigint }) => Promise<{ hash: string; fee?: bigint }> }).approve({
        token: approval.token,
        spender: approval.spender,
        amount: approval.amount,
      })
      console.log(`Approval tx submitted: hash=${approvalResult.hash}  fee=${approvalResult.fee !== undefined ? String(approvalResult.fee) : 'n/a'}`)
      console.log('Polling for approval to be mined (every 10 s, max 5 min)...')

      const MAX_POLLS = 30 // 30 × 10 s = 300 s = 5 min
      let mined = false
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000))
        const allowance: bigint = await (evmAccount as { getAllowance: (token: string, spender: string) => Promise<bigint> }).getAllowance(approval.token, approval.spender)
        console.log(`  [poll ${i + 1}/${MAX_POLLS}] allowance=${String(allowance)}  required=${String(approval.amount)}`)
        if (BigInt(allowance) >= BigInt(approval.amount)) {
          console.log('Approval confirmed on-chain.')
          mined = true
          break
        }
      }
      if (!mined) {
        console.error('ERROR: Approval not mined within 5 minutes. Aborting to avoid failed swap.')
        process.exit(1)
      }
    } else {
      console.log('No approval required (allowance already sufficient).')
    }

    const r = await sw.swidge(opts)
    orderId = r.id
    console.log(`ORDER_ID=${r.id}`)
    console.log(`EVM_TXID=${r.hash}`)
    console.log(`toTokenAmount="${String(r.toTokenAmount)}"`)
    console.log(`fromTokenAmount="${String(r.fromTokenAmount)}"`)
  } catch (err) {
    console.error(`offramp failed${orderId !== undefined ? ` ORDER_ID=${orderId}` : ''}:`, err)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// PHASE: status — read order status + wallet balances (read-only, no tx)
// ---------------------------------------------------------------------------
if (PHASE === 'status') {
  if (!ORDER_ID) {
    console.error('ERROR: ORDER_ID is required for status phase')
    process.exit(1)
  }

  try {
    // Status lookup is read-only; any account works — use EVM for convenience.
    const sw = new GatewaySwidge(evmAccount, { fromChain: 'ethereum' })
    const status = await sw.getSwidgeStatus(ORDER_ID)
    console.log(JSON.stringify(status, null, 2))

    // Print current USDT balance on EVM using ethers (already a project dep).
    const { JsonRpcProvider, Contract } = await import('ethers')
    const provider = new JsonRpcProvider(EVM_RPC_URL)
    const usdtAbi = ['function balanceOf(address owner) view returns (uint256)']
    const usdtContract = new Contract(USDT, usdtAbi, provider)
    const usdtBalance: bigint = await usdtContract.balanceOf(evmAddress)

    console.log(`EVM address: ${evmAddress}`)
    console.log(`USDT balance (6dp): ${String(usdtBalance)}`)
    console.log(`BTC address: ${btcAddress}`)
  } catch (err) {
    console.error(`status failed ORDER_ID=${ORDER_ID}:`, err)
    process.exit(1)
  }
}

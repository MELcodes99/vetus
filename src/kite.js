import { execFile } from "node:child_process";
import { config } from "./config.js";

// Read the x402 price a merchant asks for, without paying.
// Supports x402 v2 (PAYMENT-REQUIRED header) and v1 (JSON body with accepts[]).
export async function quote(payee) {
  if (payee.kind !== "x402") return null;
  try {
    const res = await fetch(payee.url, {
      method: payee.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: payee.method && payee.method !== "GET" ? JSON.stringify(payee.body ?? {}) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 402) return null;

    let req = null;
    const header = res.headers.get("payment-required");
    if (header) req = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    else req = await res.json().catch(() => null);

    const offer = req?.accepts?.[0];
    const atomic = offer?.amount ?? offer?.maxAmountRequired;
    if (atomic == null) return null;
    const decimals = offer?.extra?.decimals ?? 6; // USDC
    return Number(atomic) / 10 ** decimals;
  } catch {
    return null; // A failed quote never blocks on its own; the hard limits still apply.
  }
}

// Run kpass with arguments passed directly (execFile, never a shell) and parse its JSON.
function kpass(args) {
  return new Promise((resolve) => {
    execFile(config.kpassBin, [...args, "--output", "json", "--no-interactive"], { cwd: config.kpassDir, timeout: 120_000 },
      (err, stdout, stderr) => {
        let out = null;
        try { out = JSON.parse(stdout); } catch { /* not JSON */ }
        resolve({ out, stdout: stdout || "", stderr: stderr || "", err });
      });
  });
}

const failure = ({ out, stderr, err }) => ({
  ok: false,
  error: out?.hint || out?.user_message || out?.error || stderr.trim().slice(0, 300) || err?.message || "kpass failed",
});

// Pay an x402 service through Kite Agent Passport. kpass enforces the account allowance.
export async function payX402({ payee, idempotencyKey }) {
  const args = ["session", "execute", "--url", payee.url, "--method", payee.method || "GET", "--idempotency-key", idempotencyKey];
  if (payee.method && payee.method !== "GET") {
    args.push("--headers", JSON.stringify({ "Content-Type": "application/json" }));
    args.push("--body", JSON.stringify(payee.body ?? {}));
  }
  const r = await kpass(args);
  const p = r.out?.payment;
  if (r.out?.status !== "success" || !p?.payment_response?.success) return failure(r);
  return {
    ok: true,
    amount: Number(p.amount) / 1e6,
    tx: p.payment_response.transaction,
    network: p.network,
    allowanceLeft: r.out.usage?.period?.remaining ?? null,
  };
}

// Send USDC straight to a trusted wallet (a caregiver, a family member, a merchant that takes USDC).
export async function sendUsdc({ payee, amount }) {
  const chain = payee.chain || config.walletChain;
  const r = await kpass(["wallet", "send", "--chain", chain, "--to", payee.address, "--amount", String(amount), "--asset", "USDC"]);
  const o = r.out || {};
  // Kite requires the wallet owner's passkey for direct transfers. kpass returns an approval link;
  // the family approves with their passkey and only then does money move.
  const approvalUrl = (`${r.stdout} ${r.stderr}`.match(/https:\/\/[^\s"']*approve[^\s"']*/) || [])[0];
  if (approvalUrl) {
    const fromBlock = chain === "base" ? await baseBlockNumber().catch(() => null) : null;
    return { ok: false, needsApproval: true, approvalUrl, requestId: o.request_id || o.id || null, fromBlock };
  }
  const okStatus = ["success", "submitted", "confirmed", "completed"].includes(String(o.status || "").toLowerCase());
  if (!okStatus) return failure(r);
  // kpass's field names for the transaction differ by chain; find the first hash-like value.
  const text = JSON.stringify(o);
  const tx = o.transaction || o.tx_hash || o.txHash || o.signature || o.hash ||
    (text.match(/0x[a-fA-F0-9]{64}/) || [])[0] || null;
  return { ok: true, amount: Number(amount), tx, network: chainToNetwork(chain), allowanceLeft: o.usage?.period?.remaining ?? null };
}

export function pay({ payee, amount, idempotencyKey }) {
  return payee.kind === "wallet" ? sendUsdc({ payee, amount }) : payX402({ payee, idempotencyKey });
}

const NETWORKS = { base: "eip155:8453", polygon: "eip155:137", avalanche: "eip155:43114", arc: "arc", solana: "solana" };
const chainToNetwork = (chain) => NETWORKS[chain] || chain;

export function explorerUrl(network, tx) {
  if (!tx) return null;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  if (network === "eip155:137") return `https://polygonscan.com/tx/${tx}`;
  if (network === "eip155:43114") return `https://snowtrace.io/tx/${tx}`;
  if (network === "solana") return `https://solscan.io/tx/${tx}`;
  return null;
}

export const isEvmAddress = (a) => /^0x[a-fA-F0-9]{40}$/.test(String(a || ""));

// ---- On-chain confirmation for passkey-approved transfers ----
// After the family approves with their passkey, Kite sends the USDC. Vetus confirms it by finding
// the USDC Transfer event to the payee on Base, so "paid" is backed by the chain, not by a button.

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const watchStatus = { lastRunAt: null, lastError: null, lastRpc: null, lastRange: null, found: 0 };

async function rpcAt(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  if (json.error) throw new Error(`${new URL(url).host}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

// Try each configured Base RPC in turn until one answers.
async function rpc(method, params) {
  const errors = [];
  for (const url of config.baseRpcUrls) {
    try {
      const out = await rpcAt(url, method, params);
      watchStatus.lastRpc = new URL(url).host;
      return out;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(" | "));
}

export async function baseBlockNumber() {
  return parseInt(await rpc("eth_blockNumber", []), 16);
}

// Find a USDC transfer of exactly `amount` to `to` since `fromBlock`. Skips hashes already used.
// Searches in small windows, newest first, because public RPCs cap the block range per query.
const CHUNK = 500;
export async function findUsdcTransfer({ to, amount, fromBlock, exclude = [] }) {
  const latest = await baseBlockNumber();
  const start = Math.max(fromBlock ? fromBlock - 5 : latest - 3000, latest - 6000);
  const topicTo = "0x" + to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const want = BigInt(Math.round(Number(amount) * 1e6));
  watchStatus.lastRange = [start, latest];
  for (let hi = latest; hi >= start; hi -= CHUNK) {
    const lo = Math.max(start, hi - CHUNK + 1);
    const logs = await rpc("eth_getLogs", [{
      address: USDC_BASE,
      fromBlock: "0x" + lo.toString(16),
      toBlock: "0x" + hi.toString(16),
      topics: [TRANSFER_TOPIC, null, topicTo],
    }]);
    const hit = (logs || []).find((l) => BigInt(l.data) === want && !exclude.includes(l.transactionHash));
    if (hit) return { tx: hit.transactionHash, block: parseInt(hit.blockNumber, 16) };
  }
  return null;
}

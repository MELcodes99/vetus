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
  if (approvalUrl) return { ok: false, needsApproval: true, approvalUrl, requestId: o.request_id || o.id || null };
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

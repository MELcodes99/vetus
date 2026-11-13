import { randomUUID } from "node:crypto";
import { store } from "./store.js";
import { runRules, stricter } from "./rules.js";
import { servVet, servCheck } from "./serv.js";
import { quote, pay, explorerUrl, findUsdcTransfer, watchStatus } from "./kite.js";
export { watchStatus };
import { config } from "./config.js";

// Listeners (the Telegram bot) get told when a decision changes, so families hear about it instantly.
const listeners = new Set();
export const onDecision = (fn) => listeners.add(fn);
const emit = (event, d) => listeners.forEach((fn) => Promise.resolve(fn(event, d)).catch((e) => console.error("[vetus] listener", e.message)));

// The whole decision pipeline:
// hard rules -> x402 price check -> SERV reasoning -> strictest verdict wins -> pay via Kite, hold, or block.
export async function handlePaymentRequest(household, input, { source = "dashboard", requestedBy = null } = {}) {
  const policy = household.policy;
  const payee = input.payeeId ? store.payee(household, input.payeeId) : null;
  const request = {
    payeeId: payee?.id ?? null,
    payeeName: payee?.name ?? String(input.payeeName || "Unknown payee").slice(0, 80),
    amount: Number(input.amount),
    memo: String(input.memo || "").slice(0, 300),
    context: String(input.context || "").slice(0, 2000),
  };
  const spentToday = store.spentToday(household.id);
  const quotedAmount = payee ? await quote(payee) : null;
  const rules = runRules({ request, payee, policy, spentToday, quotedAmount });

  let reasoning;
  let verdict = rules.verdict;
  try {
    reasoning = await servVet({ request, payee, policy, ruleChecks: rules.checks, spentToday });
    verdict = stricter(verdict, reasoning.verdict);
  } catch (e) {
    // Fail closed: if the reasoning layer is down, a human decides.
    reasoning = { error: e.message, raw: e.raw?.slice(0, 4000) };
    verdict = stricter(verdict, "HOLD");
  }

  // A payee not on the list has no payment route, so it can never auto-pay.
  if (verdict === "APPROVE" && !payee) verdict = "HOLD";

  const decision = store.addDecision({
    id: randomUUID(),
    householdId: household.id,
    createdAt: new Date().toISOString(),
    source,
    requestedBy,
    request,
    quotedAmount,
    rules: rules.checks,
    reasoning,
    verdict,
    ...explain(verdict, reasoning, rules.checks, household),
    status: verdict === "APPROVE" ? "paying" : verdict === "HOLD" ? "awaiting_family" : "blocked",
  });

  if (verdict === "APPROVE") return settle(decision.id, "vetus");
  emit(verdict === "HOLD" ? "held" : "blocked", decision);
  return decision;
}

// Check a forwarded message for scam signs. Nothing is paid.
export async function checkMessage(household, text, { requestedBy = null } = {}) {
  let reasoning;
  let verdict;
  try {
    reasoning = await servCheck({ text });
    verdict = reasoning.verdict;
  } catch (e) {
    reasoning = { error: e.message, raw: e.raw?.slice(0, 4000) };
    verdict = "HOLD";
  }
  const check = {
    id: randomUUID(),
    householdId: household?.id ?? null,
    createdAt: new Date().toISOString(),
    requestedBy,
    text: String(text).slice(0, 2000),
    reasoning,
    verdict,
    elderMessage: reasoning.elderMessage || (verdict === "HOLD" ? "I couldn't check this properly right now. Please don't act on it until you've spoken to your family." : ""),
    familyMessage: reasoning.familyMessage || "",
  };
  store.addCheck(check);
  if (household && verdict !== "APPROVE") emit("check", check);
  return check;
}

// Use the model's words when it agrees with the final verdict.
// When a stricter rule overrides it, Vetus explains in its own words so messages never contradict the outcome.
function explain(verdict, reasoning, ruleChecks, household) {
  if (reasoning && !reasoning.error && reasoning.verdict === verdict) {
    return { familyMessage: reasoning.familyMessage, elderMessage: reasoning.elderMessage };
  }
  const caught = ruleChecks.filter((c) => c.verdict === verdict).map((c) => c.finding);
  const why = caught[0] || (reasoning?.error ? "The reasoning check was unavailable, so a person should decide." : "It needs a second look.");
  const helper = household.family?.[0]?.name || "your family";
  if (verdict === "BLOCK") {
    return { familyMessage: `Blocked by the family rules. ${why}`, elderMessage: `Vetus stopped this payment to keep you safe. Please talk to ${helper} before sending anything.` };
  }
  return { familyMessage: `Held for your OK. ${why}`, elderMessage: `This one needs a quick OK from ${helper} first. Nothing has been sent yet.` };
}

// Does this household's money move for real right now?
export function liveMode(household) {
  if (config.dryRun || household.demo) return "dry_run";
  return household.paymentsEnabled ? "live" : "not_enabled";
}

export async function settle(id, approvedBy) {
  const d = store.decision(id);
  if (!d) return null;
  const household = store.household(d.householdId);
  const payee = d.request.payeeId ? store.payee(household, d.request.payeeId) : null;
  if (!payee) {
    const out = store.updateDecision(id, { status: "failed", approvedBy, payError: "This payee has no payment route. Add it as a trusted payee first." });
    emit("failed", out);
    return out;
  }

  const mode = liveMode(household);
  if (mode === "dry_run") {
    const out = store.updateDecision(id, { status: "paid", approvedBy, paidAmount: d.request.amount, tx: null, dryRun: true });
    emit("paid", out);
    return out;
  }
  if (mode === "not_enabled") {
    const out = store.updateDecision(id, { status: "approved_not_sent", approvedBy });
    emit("approved_not_sent", out);
    return out;
  }

  store.updateDecision(id, { status: "paying", approvedBy });
  const result = await pay({ payee, amount: d.request.amount, idempotencyKey: `vetus-${id}` });
  if (result.needsApproval) {
    const out = store.updateDecision(id, {
      status: "awaiting_passkey",
      approvalUrl: result.approvalUrl,
      passkeyRequestId: result.requestId,
      watchFromBlock: result.fromBlock,
      watchSince: new Date().toISOString(),
    });
    emit("awaiting_passkey", out);
    return out;
  }
  if (!result.ok) {
    const out = store.updateDecision(id, { status: "failed", payError: result.error });
    emit("failed", out);
    return out;
  }
  const out = store.updateDecision(id, {
    status: "paid",
    paidAmount: result.amount,
    tx: result.tx,
    network: result.network,
    txUrl: explorerUrl(result.network, result.tx),
    allowanceLeft: result.allowanceLeft,
  });
  emit("paid", out);
  return out;
}

// A family member approves or declines a held payment. Only once.
export async function familyDecide(id, action, who = "family") {
  const d = store.decision(id);
  if (!d) return { error: "not found", code: 404 };
  if (d.status !== "awaiting_family") return { error: `already ${d.status.replaceAll("_", " ")}`, code: 409 };
  if (action === "deny") {
    const out = store.updateDecision(id, { status: "denied", deniedBy: who });
    emit("denied", out);
    return out;
  }
  store.updateDecision(id, { status: "approving" }); // claims it, so a double tap cannot pay twice
  return settle(id, who);
}

// Watch Base for transfers the family released with their passkey, and mark them paid with the receipt.
const WATCH_FOR_MS = 30 * 60 * 1000;
export async function checkPasskeyPayments(now = Date.now()) {
  const waiting = store.allDecisions().filter((d) => d.status === "awaiting_passkey");
  watchStatus.lastRunAt = new Date(now).toISOString();
  watchStatus.waiting = waiting.length;
  for (const d of waiting) {
    const household = store.household(d.householdId);
    const payee = household && d.request.payeeId ? store.payee(household, d.request.payeeId) : null;
    if (!payee?.address || (payee.chain || config.walletChain) !== "base") continue;
    try {
      const used = store.allDecisions().map((x) => x.tx).filter(Boolean);
      const hit = await findUsdcTransfer({ to: payee.address, amount: d.request.amount, fromBlock: d.watchFromBlock, exclude: used });
      watchStatus.lastError = null;
      if (hit) {
        watchStatus.found++;
        const out = store.updateDecision(d.id, { status: "paid", paidAmount: d.request.amount, tx: hit.tx, network: "eip155:8453", txUrl: explorerUrl("eip155:8453", hit.tx), approvedBy: d.approvedBy && d.approvedBy !== "vetus" ? d.approvedBy : "family passkey" });
        emit("paid", out);
        continue;
      }
    } catch (e) {
      watchStatus.lastError = e.message.slice(0, 500);
      console.error("[vetus] passkey watch:", e.message);
    }
    if (now - Date.parse(d.watchSince || d.updatedAt || d.createdAt) > WATCH_FOR_MS) {
      const out = store.updateDecision(d.id, { status: "passkey_expired" });
      emit("passkey_expired", out);
    }
  }
}

export function startPasskeyWatcher(intervalMs = 15_000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap two checks
    running = true;
    try { await checkPasskeyPayments(); } catch { /* logged inside */ } finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

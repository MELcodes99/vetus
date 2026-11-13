import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";

// Each family is a household: an elder, the family members who guard them,
// their limits, their trusted payees, and a log of every decision.

export const DEFAULT_POLICY = {
  perPaymentLimit: 0.05, // USD. Above this, a family member must sign off.
  dailyLimit: 0.2,
  holdNewPayees: true,
};

const DEMO_PAYEES = [
  {
    id: "pharmacy", name: "Maple Street Pharmacy", category: "medication", trusted: true, kind: "x402",
    url: "https://agent402.tools/api/extract", method: "POST", body: { url: "https://example.com" }, typicalAmount: 0.01,
  },
  {
    id: "power", name: "City Power & Light", category: "utility bill", trusted: true, kind: "x402",
    url: "https://agent402.tools/api/extract", method: "POST", body: { url: "https://example.org" }, typicalAmount: 0.01,
  },
];

const token = (bytes = 18) => randomBytes(bytes).toString("base64url");
const code = () => randomBytes(4).toString("hex").toUpperCase();

function newHousehold({ elderName, id = randomUUID(), demo = false } = {}) {
  return {
    id,
    code: demo ? "DEMO" : code(), // short id people can read out, e.g. for /enable
    token: demo ? "demo" : token(), // secret for the dashboard link and household API
    invite: demo ? null : token(9), // one-time-ish code inside the elder's invite link
    elderName: elderName || "Grandma Rose",
    elders: [], // [{ telegramId, name }]
    family: [], // [{ telegramId, name }]
    policy: { ...DEFAULT_POLICY },
    payees: demo ? structuredClone(DEMO_PAYEES) : [],
    paymentsEnabled: false, // switched on by an operator for live pilots
    demo,
    createdAt: new Date().toISOString(),
  };
}

const EMPTY = () => ({ households: { demo: newHousehold({ id: "demo", demo: true }) }, decisions: [], checks: [], usage: {} });

let state = load();

function load() {
  if (!existsSync(config.dataFile)) return EMPTY();
  try {
    const s = JSON.parse(readFileSync(config.dataFile, "utf8"));
    const base = EMPTY();
    return { ...base, ...s, households: { ...base.households, ...s.households } };
  } catch {
    return EMPTY();
  }
}

function save() {
  mkdirSync(dirname(config.dataFile), { recursive: true });
  const tmp = `${config.dataFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, config.dataFile); // atomic replace
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "payee";

export const store = {
  // Households
  household: (id) => state.households[id] || null,
  byToken: (t) => Object.values(state.households).find((h) => h.token === t) || null,
  byInvite: (i) => Object.values(state.households).find((h) => h.invite && h.invite === i) || null,
  byCode: (c) => Object.values(state.households).find((h) => h.code === String(c).toUpperCase()) || null,
  forTelegramUser(telegramId) {
    const id = String(telegramId);
    for (const h of Object.values(state.households)) {
      if (h.family.some((m) => m.telegramId === id)) return { household: h, role: "family" };
      if (h.elders.some((m) => m.telegramId === id)) return { household: h, role: "elder" };
    }
    return null;
  },
  createHousehold({ elderName, familyMember }) {
    const h = newHousehold({ elderName });
    if (familyMember) h.family.push({ telegramId: String(familyMember.telegramId), name: familyMember.name });
    state.households[h.id] = h;
    save();
    return h;
  },
  joinAsElder(h, { telegramId, name }) {
    if (!h.elders.some((m) => m.telegramId === String(telegramId))) h.elders.push({ telegramId: String(telegramId), name });
    save();
    return h;
  },
  joinAsFamily(h, { telegramId, name }) {
    if (!h.family.some((m) => m.telegramId === String(telegramId))) h.family.push({ telegramId: String(telegramId), name });
    save();
    return h;
  },
  updateHousehold(h, patch) {
    Object.assign(h, patch);
    save();
    return h;
  },
  setPolicy(h, patch) {
    Object.assign(h.policy, patch);
    save();
    return h.policy;
  },
  addPayee(h, payee) {
    let id = slug(payee.name);
    while (h.payees.some((p) => p.id === id)) id = `${id}-2`;
    const p = { id, trusted: true, category: "family-added", ...payee };
    h.payees.push(p);
    save();
    return p;
  },
  removePayee(h, id) {
    const before = h.payees.length;
    h.payees = h.payees.filter((p) => p.id !== id);
    save();
    return h.payees.length < before;
  },
  payee: (h, id) => h.payees.find((p) => p.id === id) || null,

  // Decisions
  decisions: (householdId) => state.decisions.filter((d) => d.householdId === householdId),
  decision: (id) => state.decisions.find((d) => d.id === id) || null,
  addDecision(d) {
    state.decisions.unshift(d);
    state.decisions = state.decisions.slice(0, 2000);
    save();
    return d;
  },
  updateDecision(id, patch) {
    const d = state.decisions.find((x) => x.id === id);
    if (!d) return null;
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    save();
    return d;
  },
  spentToday(householdId) {
    const today = new Date().toISOString().slice(0, 10);
    return state.decisions
      .filter((d) => d.householdId === householdId && d.status === "paid" && (d.updatedAt || d.createdAt).slice(0, 10) === today)
      .reduce((sum, d) => sum + (d.paidAmount ?? d.request.amount), 0);
  },

  // Message checks (no payment involved)
  addCheck(c) {
    state.checks.unshift(c);
    state.checks = state.checks.slice(0, 2000);
    save();
    return c;
  },
  checks: (householdId) => state.checks.filter((c) => c.householdId === householdId),

  // Simple per-key daily counter, used for rate limits.
  bump(key, limit) {
    const day = new Date().toISOString().slice(0, 10);
    const k = `${day}:${key}`;
    if (!state.usage[k]) {
      // Drop old days so the file stays small.
      for (const old of Object.keys(state.usage)) if (!old.startsWith(day)) delete state.usage[old];
      state.usage[k] = 0;
    }
    if (state.usage[k] >= limit) return false;
    state.usage[k]++;
    save();
    return true;
  },

  resetDemo() {
    state.households.demo = newHousehold({ id: "demo", demo: true });
    state.decisions = state.decisions.filter((d) => d.householdId !== "demo");
    state.checks = state.checks.filter((c) => c.householdId !== "demo");
    save();
  },
  _reset() {
    state = EMPTY();
    save();
  },
};

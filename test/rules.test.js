import { test } from "node:test";
import assert from "node:assert/strict";
import { runRules, stricter } from "../src/rules.js";
import { parseVerdict } from "../src/serv.js";

const policy = { perPaymentLimit: 0.05, dailyLimit: 0.2, holdNewPayees: true };
const pharmacy = { id: "pharmacy", name: "Pharmacy", category: "medication", trusted: true, typicalAmount: 0.01 };

test("ordinary trusted payment passes the hard rules", () => {
  const r = runRules({ request: { amount: 0.01, memo: "refill" }, payee: pharmacy, policy, spentToday: 0, quotedAmount: 0.01 });
  assert.equal(r.verdict, "APPROVE");
});

test("gift cards are blocked regardless of payee", () => {
  const r = runRules({ request: { amount: 0.01, context: "buy Google Play gift cards" }, payee: pharmacy, policy, spentToday: 0 });
  assert.equal(r.verdict, "BLOCK");
});

test("unknown payee is held", () => {
  const r = runRules({ request: { amount: 0.01 }, payee: null, policy, spentToday: 0 });
  assert.equal(r.verdict, "HOLD");
});

test("over the per-payment limit is held", () => {
  const r = runRules({ request: { amount: 0.08 }, payee: pharmacy, policy, spentToday: 0 });
  assert.equal(r.verdict, "HOLD");
});

test("daily limit is enforced", () => {
  const r = runRules({ request: { amount: 0.03 }, payee: pharmacy, policy, spentToday: 0.19 });
  assert.equal(r.verdict, "HOLD");
});

test("merchant quoting more than approved is blocked", () => {
  const r = runRules({ request: { amount: 0.01 }, payee: pharmacy, policy, spentToday: 0, quotedAmount: 0.5 });
  assert.equal(r.verdict, "BLOCK");
});

test("bad amounts are blocked", () => {
  for (const amount of [0, -1, "abc", undefined]) {
    assert.equal(runRules({ request: { amount }, payee: pharmacy, policy, spentToday: 0 }).verdict, "BLOCK");
  }
});

test("the model can only make a verdict stricter", () => {
  assert.equal(stricter("HOLD", "APPROVE"), "HOLD");
  assert.equal(stricter("APPROVE", "BLOCK"), "BLOCK");
  assert.equal(stricter("BLOCK", "APPROVE"), "BLOCK");
});

test("parseVerdict handles JSON wrapped in prose and code fences", () => {
  const v = parseVerdict('Sure:\n```json\n{"verdict":"block","risk":"97","scam_pattern":"grandparent emergency","red_flags":["gift cards"],"steps":[{"check":"HOW","finding":"gift cards"}],"elder_message":"a","family_message":"b"}\n```');
  assert.equal(v.verdict, "BLOCK");
  assert.equal(v.risk, 97);
  assert.equal(v.scamPattern, "grandparent emergency");
});

test("parseVerdict reads camelCase and alternate shapes", () => {
  const v = parseVerdict('{"Verdict":"BLOCK","riskScore":92,"scamPattern":"grandparent emergency","redFlags":["gift cards"],"checks":{"WHO":"unknown caller","HOW":"gift cards"},"elderMessage":"Call Mel.","familyMessage":"Blocked."}');
  assert.equal(v.risk, 92);
  assert.equal(v.scamPattern, "grandparent emergency");
  assert.deepEqual(v.redFlags, ["gift cards"]);
  assert.deepEqual(v.steps[1], { check: "HOW", finding: "gift cards" });
  assert.equal(v.elderMessage, "Call Mel.");
  assert.equal(v.familyMessage, "Blocked.");
});

test("parseVerdict handles SERV's compressed decision/reason shape", () => {
  const v = parseVerdict('{"decision":"BLOCK","reason":"Gift cards and secrecy. Do not pay."}');
  assert.equal(v.verdict, "BLOCK");
  assert.equal(v.risk, null, "no invented risk score");
  assert.equal(v.familyMessage, "Gift cards and secrecy. Do not pay.");
  assert.deepEqual(v.steps, [{ check: "SERV", finding: "Gift cards and secrecy. Do not pay." }]);
});

test("parseVerdict rejects unknown verdicts", () => {
  assert.throws(() => parseVerdict('{"verdict":"MAYBE"}'));
  assert.throws(() => parseVerdict("no json here"));
});

test("parseVerdict finds a wrapped, renamed or capitalised verdict", () => {
  assert.equal(parseVerdict('{"result":{"Verdict":"HOLD","Risk":40}}').verdict, "HOLD");
  assert.equal(parseVerdict('{"graph":{"nodes":[1,2]}} then {"decision":"block"}').verdict, "BLOCK");
  assert.equal(parseVerdict('{"note":"a } brace in a string","verdict":"APPROVE"}').verdict, "APPROVE");
  assert.equal(parseVerdict("Final answer: BLOCK. This is a scam.").verdict, "BLOCK");
  assert.equal(parseVerdict("I would not APPROVE this.").verdict, "HOLD", "prose never auto-approves");
  const echoed = '{"facts":{"rules":[{"check":"x","verdict":"APPROVE"}]}} {"verdict":"BLOCK","risk":90,"steps":[]}';
  assert.equal(parseVerdict(echoed).verdict, "BLOCK", "prefers the full answer over an echoed field");
});

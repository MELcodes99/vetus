// Hard rules. These run before any model and can never be loosened by one.
// The model may make a decision stricter, never softer.

export const VERDICT_RANK = { APPROVE: 0, HOLD: 1, BLOCK: 2 };
export const stricter = (a, b) => (VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b);

const GIFT_CARD = /\b(gift ?cards?|itunes|google play|steam card|apple card|vanilla visa)\b/i;
const CRYPTO_ATM = /\b(bitcoin atm|crypto atm|btc atm)\b/i;
const WIRE = /\b(wire transfer|western union|moneygram|zelle me)\b/i;

export function runRules({ request, payee, policy, spentToday, quotedAmount }) {
  const checks = [];
  let verdict = "APPROVE";
  const flag = (v, check, finding) => {
    checks.push({ check, finding, verdict: v });
    verdict = stricter(verdict, v);
  };

  const amount = Number(request.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    flag("BLOCK", "Valid amount", "Amount is missing or not a positive number.");
    return { verdict, checks };
  }

  const text = `${request.memo || ""} ${request.context || ""}`;
  if (GIFT_CARD.test(text)) flag("BLOCK", "Payment method", "Asks for gift cards. Real bills are never paid in gift cards.");
  if (CRYPTO_ATM.test(text)) flag("BLOCK", "Payment method", "Asks for a crypto ATM deposit, a classic scam channel.");
  if (WIRE.test(text)) flag("HOLD", "Payment method", "Asks for an untraceable wire or cash app transfer.");

  if (!payee) {
    flag(policy.holdNewPayees ? "HOLD" : "APPROVE", "Known payee", "This payee is not on the family's list.");
  } else if (!payee.trusted) {
    flag("HOLD", "Known payee", `${payee.name} is on the list but not marked trusted.`);
  } else {
    checks.push({ check: "Known payee", finding: `${payee.name} is a trusted ${payee.category}.`, verdict: "APPROVE" });
  }

  if (amount > policy.perPaymentLimit) {
    flag("HOLD", "Per-payment limit", `$${amount} is above the $${policy.perPaymentLimit} limit the family set.`);
  }
  if (spentToday + amount > policy.dailyLimit) {
    flag("HOLD", "Daily limit", `This would take today's spend to $${(spentToday + amount).toFixed(3)}, above $${policy.dailyLimit}.`);
  }
  if (payee?.typicalAmount && amount > payee.typicalAmount * 5) {
    flag("HOLD", "Usual amount", `${payee.name} usually costs $${payee.typicalAmount}; this is ${Math.round(amount / payee.typicalAmount)}x that.`);
  }
  if (quotedAmount != null && quotedAmount > amount + 1e-9) {
    flag("BLOCK", "Merchant quote", `The merchant's x402 quote is $${quotedAmount}, more than the $${amount} that was approved.`);
  }

  return { verdict, checks };
}

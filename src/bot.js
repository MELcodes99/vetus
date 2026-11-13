import { config } from "./config.js";
import { store } from "./store.js";
import { handlePaymentRequest, checkMessage, familyDecide, onDecision, liveMode } from "./vet.js";
import { isEvmAddress } from "./kite.js";

// Vetus on Telegram.
// - A family member sets up a household and sends the elder an invite link.
// - The elder forwards any suspicious message for a scam check, or asks to pay someone.
// - The family gets held payments with Approve / Decline buttons, and alerts for blocked scams.

const ICON = { APPROVE: "🟢", HOLD: "🟡", BLOCK: "🔴" };
const CHECK_HEAD = { APPROVE: "🟢 This looks safe.", HOLD: "🟡 Be careful with this one.", BLOCK: "🔴 This looks like a scam." };
const money = (n) => `$${Number(n).toFixed(Number(n) < 1 ? 3 : 2)}`;
const nameOf = (from) => [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Family";

const COMMANDS = [
  { command: "pay", description: "Pay someone (Vetus checks it first)" },
  { command: "check", description: "How to check a suspicious message" },
  { command: "payees", description: "Trusted payees" },
  { command: "addpayee", description: "Family: add a trusted USDC wallet" },
  { command: "limits", description: "Spending limits" },
  { command: "setlimit", description: "Family: change limits" },
  { command: "history", description: "Recent payments and checks" },
  { command: "dashboard", description: "Open the family dashboard" },
  { command: "invite", description: "Family: invite links" },
  { command: "help", description: "What Vetus can do" },
];

export function createBot(api) {
  const convo = new Map(); // telegramId -> { step, ...draft }
  let username = config.botUsername;

  const link = (payload) => (username ? `https://t.me/${username}?start=${payload}` : `(start the bot with: /start ${payload})`);
  const dashboardUrl = (h) => `${config.publicUrl}/h/${h.token}`;
  const httpsDashboard = (h) => (config.publicUrl.startsWith("https://") ? dashboardUrl(h) : null);
  const tellFamily = (h, text, extra) => Promise.all(h.family.map((m) => api.send(m.telegramId, text, extra).catch(() => {})));
  const tellElders = (h, text, extra) => Promise.all(h.elders.map((m) => api.send(m.telegramId, text, extra).catch(() => {})));

  async function init() {
    if (!username) username = (await api.getMe()).username;
    await api.setCommands(COMMANDS);
    return username;
  }

  // ---------- Notifications from the decision pipeline ----------

  onDecision(async (event, d) => {
    if (event === "check") return notifyCheck(d);
    const h = store.household(d.householdId);
    if (!h) return;
    const r = d.reasoning || {};
    const what = `${d.request.payeeName} · ${money(d.request.amount)}${d.request.memo ? ` · "${d.request.memo}"` : ""}`;
    const flags = r.redFlags?.length ? `\nRed flags: ${r.redFlags.join(", ")}` : "";
    const risk = r.risk != null ? ` · risk ${r.risk}` : "";
    const dash = httpsDashboard(h);
    const traceButton = dash ? [[{ text: "See full reasoning", url: dash }]] : [];

    if (event === "held") {
      await tellFamily(h, `🟡 ${h.elderName} wants to pay ${what}${risk}\n\n${d.familyMessage}${flags}\n\nShould Vetus send it?`, {
        reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `ap:${d.id}` }, { text: "✖️ Decline", callback_data: `dn:${d.id}` }], ...traceButton] },
      });
      return tellElders(h, `🟡 ${d.elderMessage}`);
    }
    if (event === "blocked") {
      await tellFamily(h, `🔴 Vetus blocked a payment for ${h.elderName}: ${what}${risk}\n\n${d.familyMessage}${flags}\n\nNo money left the wallet.`, { reply_markup: { inline_keyboard: traceButton } });
      return tellElders(h, `🔴 ${d.elderMessage}\n\nNo money was sent.`);
    }
    if (event === "paid") {
      const receipt = d.dryRun ? "(demo, no money moved)" : d.txUrl ? `Receipt: ${d.txUrl}` : d.tx ? `Transaction: ${d.tx}` : "";
      const paidWhat = `${money(d.paidAmount ?? d.request.amount)} to ${d.request.payeeName}`;
      const by = d.approvedBy && d.approvedBy !== "vetus" ? ` after ${d.approvedBy} approved it` : "";
      await tellFamily(h, `✅ Paid ${paidWhat}${by}. ${receipt}`);
      return tellElders(h, `✅ Done. ${paidWhat} has been paid.${by && " Your family approved it."}`);
    }
    if (event === "approved_not_sent") {
      const msg = `🟢 Vetus approved ${what}, but live payments aren't switched on for this household yet, so nothing was sent.`;
      await tellFamily(h, `${msg}\nHousehold code: ${h.code}`);
      return tellElders(h, msg);
    }
    if (event === "awaiting_passkey") {
      await tellFamily(h, `🔐 Vetus checked and approved ${what}${risk}.\n\n${d.familyMessage}\n\nLast step: confirm the transfer with your Kite passkey. The money only moves after you approve it there.`, {
        reply_markup: { inline_keyboard: [[{ text: "🔐 Confirm with passkey", url: d.approvalUrl }], ...traceButton] },
      });
      return tellElders(h, `🟢 That payment looks fine. Your family is giving the final OK now.`);
    }
    if (event === "denied") {
      await tellFamily(h, `✖️ Declined: ${what}. Nothing was sent.`);
      return tellElders(h, `Your family decided not to send ${what}. Nothing was sent.`);
    }
    if (event === "failed") {
      await tellFamily(h, `⚠️ Payment failed for ${what}: ${d.payError}`);
      return tellElders(h, `⚠️ That payment didn't go through. Nothing was sent. Your family has been told.`);
    }
  });

  async function notifyCheck(c) {
    const h = c.householdId && store.household(c.householdId);
    if (!h) return;
    // Only alert the family when the elder (not a family member) forwarded it.
    if (!h.elders.some((m) => m.telegramId === String(c.requestedBy))) return;
    const r = c.reasoning || {};
    const preview = c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text;
    await tellFamily(h, `${ICON[c.verdict]} ${h.elderName} forwarded a message that ${c.verdict === "BLOCK" ? "looks like a scam" : "looks suspicious"}${r.scamPattern ? ` (${r.scamPattern})` : ""}.\n\n"${preview}"\n\n${c.familyMessage}\n\nVetus told them: ${c.elderMessage}`);
  }

  // ---------- Updates ----------

  async function handleUpdate(u) {
    if (u.callback_query) return onCallback(u.callback_query);
    const m = u.message;
    if (!m || !m.from || m.chat?.type !== "private") return;
    const text = (m.text || m.caption || "").trim();
    const from = m.from;
    const id = String(from.id);

    if (text.startsWith("/")) {
      convo.delete(id);
      const [cmd, ...rest] = text.split(/\s+/);
      return onCommand(m, cmd.split("@")[0].toLowerCase(), rest.join(" "));
    }
    const state = convo.get(id);
    if (state) return onConvo(m, state, text);
    if (!text) {
      return api.send(id, "I can only read text for now. Please copy the words from the message, or forward it as text, and I'll check it.");
    }
    return runCheck(m, text);
  }

  async function onCommand(m, cmd, arg) {
    const id = String(m.from.id);
    const membership = store.forTelegramUser(id);
    const h = membership?.household;
    const isFamily = membership?.role === "family";
    const requireFamily = () => (isFamily ? false : (api.send(id, h ? "Only family members can do that." : "Set up a household first with /start."), true));

    switch (cmd) {
      case "/start": return onStart(m, arg);
      case "/help": return api.send(id, helpText(membership));
      case "/check": return api.send(id, "Forward me any message, email or text you're unsure about, or paste the words, and I'll tell you if it looks like a scam. Nothing is paid.");
      case "/pay": return startPay(m, membership);
      case "/payees": {
        if (!h) return api.send(id, "You're not in a household yet. Use /start.");
        if (!h.payees.length) return api.send(id, `No trusted payees yet.${isFamily ? " Add one with:\n/addpayee Name | 0xWalletAddress" : " Ask your family to add them."}`);
        return api.send(id, `Trusted payees for ${h.elderName}:\n\n${h.payees.map((p) => `• ${p.name} (${p.kind === "wallet" ? `USDC wallet ${short(p.address)}` : "x402 service"})${p.typicalAmount ? `, usually ${money(p.typicalAmount)}` : ""}  [id: ${p.id}]`).join("\n")}`);
      }
      case "/addpayee": {
        if (requireFamily()) return;
        const [name, address, typical] = arg.split("|").map((s) => s.trim());
        if (!name || !isEvmAddress(address)) {
          return api.send(id, "Add a trusted USDC wallet like this:\n/addpayee Name | 0xWalletAddress | usual amount (optional)\n\nExample:\n/addpayee Carer Ana | 0x1234...abcd | 0.02");
        }
        const p = store.addPayee(h, { name: name.slice(0, 60), kind: "wallet", chain: config.walletChain, address, typicalAmount: typical ? Number(typical) || undefined : undefined, category: "trusted wallet" });
        return api.send(id, `Added ${p.name} (${short(p.address)} on ${p.chain}). ${h.elderName} can now pay them with /pay, and Vetus will still check every payment.`);
      }
      case "/removepayee": {
        if (requireFamily()) return;
        return api.send(id, store.removePayee(h, arg.trim()) ? "Removed." : "No payee with that id. See /payees.");
      }
      case "/limits": {
        if (!h) return api.send(id, "You're not in a household yet. Use /start.");
        return api.send(id, `Limits for ${h.elderName}:\n• Up to ${money(h.policy.perPaymentLimit)} per payment without asking\n• Up to ${money(h.policy.dailyLimit)} a day\n• New payees: ${h.policy.holdNewPayees ? "always held for family" : "allowed"}\n• Spent today: ${money(store.spentToday(h.id))}\n• Live payments: ${{ live: "on", not_enabled: "not switched on yet", dry_run: "demo mode" }[liveMode(h)]}${isFamily ? "\n\nChange with /setlimit <per payment> <per day>" : ""}`);
      }
      case "/setlimit": {
        if (requireFamily()) return;
        const [per, day] = arg.split(/\s+/).map(Number);
        if (!(per > 0) || (day !== undefined && !(day > 0))) return api.send(id, "Usage: /setlimit <per payment> <per day>\nExample: /setlimit 0.05 0.2");
        store.setPolicy(h, { perPaymentLimit: per, ...(day ? { dailyLimit: day } : {}) });
        return api.send(id, `Updated. ${h.elderName} can pay up to ${money(h.policy.perPaymentLimit)} per payment and ${money(h.policy.dailyLimit)} a day before you're asked.`);
      }
      case "/history": {
        if (!h) return api.send(id, "You're not in a household yet. Use /start.");
        const items = [
          ...store.decisions(h.id).map((d) => ({ at: d.createdAt, line: `${ICON[d.verdict]} Pay ${d.request.payeeName} ${money(d.request.amount)}: ${d.status.replaceAll("_", " ")}` })),
          ...store.checks(h.id).map((c) => ({ at: c.createdAt, line: `${ICON[c.verdict]} Message check: ${c.reasoning?.scamPattern || { APPROVE: "looked safe", HOLD: "suspicious", BLOCK: "scam" }[c.verdict]}` })),
        ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
        return api.send(id, items.length ? `Recent activity:\n\n${items.map((i) => i.line).join("\n")}` : "Nothing yet.");
      }
      case "/dashboard": {
        if (!h) return api.send(id, "You're not in a household yet. Use /start.");
        if (!isFamily) return api.send(id, "The dashboard is for family members.");
        return api.send(id, `Your family dashboard (keep this link private):\n${dashboardUrl(h)}`);
      }
      case "/invite": {
        if (requireFamily()) return;
        return api.send(id, invitesText(h));
      }
      // Operator commands for the live pilot. Real payments come from the operator's Kite Passport,
      // so they are switched on household by household.
      case "/enable":
      case "/disable": {
        if (!config.admins.includes(id)) return api.send(id, "Sorry, that command is for the Vetus team.");
        const target = store.byCode(arg.trim());
        if (!target) return api.send(id, "No household with that code.");
        store.updateHousehold(target, { paymentsEnabled: cmd === "/enable" });
        await tellFamily(target, cmd === "/enable" ? "✅ Live payments are now switched on for your household." : "Live payments have been switched off for your household.");
        return api.send(id, `${target.code} (${target.elderName}): live payments ${cmd === "/enable" ? "on" : "off"}.`);
      }
      default:
        return api.send(id, "I don't know that command. Try /help.");
    }
  }

  async function onStart(m, payload) {
    const id = String(m.from.id);
    const existing = store.forTelegramUser(id);

    if (payload?.startsWith("join_") || payload?.startsWith("fam_")) {
      const asFamily = payload.startsWith("fam_");
      const h = store.byInvite(payload.slice(payload.indexOf("_") + 1));
      if (!h) return api.send(id, "That invite link doesn't work any more. Ask your family to send a new one with /invite.");
      if (existing && existing.household.id !== h.id) return api.send(id, `You're already part of ${existing.household.elderName}'s household.`);
      if (asFamily) {
        store.joinAsFamily(h, { telegramId: id, name: nameOf(m.from) });
        await tellFamily(h, `${nameOf(m.from)} joined as family for ${h.elderName}.`);
        return api.send(id, `You're now family for ${h.elderName}. You'll get held payments to approve and alerts about scams.\n\n${helpText({ role: "family" })}`);
      }
      store.joinAsElder(h, { telegramId: id, name: nameOf(m.from) });
      await tellFamily(h, `${h.elderName} has joined Vetus. 🎉`);
      return api.send(id, `Hello ${m.from.first_name || ""}! I'm Vetus. Your family asked me to help keep your money safe.\n\nTwo things I can do:\n\n1. If you get a message, email or call you're not sure about, forward it to me or type what it says. I'll tell you if it's a scam.\n\n2. If you want to pay someone, tap /pay. I'll check it first, and if anything looks wrong I'll ask your family.`, {
        reply_markup: { inline_keyboard: [[{ text: "Pay someone", callback_data: "pay" }]] },
      });
    }

    if (existing) return api.send(id, helpText(existing));
    return api.send(id, "Hi, I'm Vetus. I check payments and messages for scams before your loved ones lose money.\n\nForward me any suspicious message and I'll check it right now, or set up protection for a family member.", {
      reply_markup: { inline_keyboard: [[{ text: "🛡 Protect a family member", callback_data: "setup" }], [{ text: "🔎 Check a message", callback_data: "howcheck" }]] },
    });
  }

  function helpText(membership) {
    if (membership?.role === "elder") return "Forward me any message you're unsure about and I'll check it.\nTap /pay to pay someone. I'll check it first.";
    if (membership?.role === "family") return `You're family for ${membership.household?.elderName ?? "your household"}.\n\n/payees, /addpayee  trusted payees\n/limits, /setlimit  spending limits\n/history  recent activity\n/dashboard  full reasoning for every decision\n/invite  invite links\n/pay  pay on their behalf\n\nYou can also forward me any message to check it.`;
    return "Forward me any message to check it for scams, or tap /start to protect a family member.";
  }

  function invitesText(h) {
    return `Household for ${h.elderName} (code ${h.code})\n\n1. Send this link to ${h.elderName} so they can join:\n${link(`join_${h.invite}`)}\n\n2. To add another family member, send them:\n${link(`fam_${h.invite}`)}\n\n3. Your private dashboard:\n${dashboardUrl(h)}`;
  }

  // ---------- Conversations ----------

  async function onCallback(q) {
    const id = String(q.from.id);
    const data = q.data || "";
    if (data === "setup") {
      await api.answer(q.id);
      if (store.forTelegramUser(id)) return api.send(id, "You're already part of a household. See /invite.");
      convo.set(id, { step: "elder_name" });
      return api.send(id, "Who are you protecting? Send me their first name, for example: Rose");
    }
    if (data === "howcheck") {
      await api.answer(q.id);
      return api.send(id, "Forward me the message, or paste what it says. I'll tell you if it's a scam.");
    }
    if (data === "pay") {
      await api.answer(q.id);
      return startPay({ from: q.from }, store.forTelegramUser(id));
    }
    if (data.startsWith("payee:")) {
      await api.answer(q.id);
      const s = convo.get(id);
      if (!s || s.step !== "payee") return;
      const pick = data.slice(6);
      if (pick === "__other") { convo.set(id, { ...s, step: "other_name" }); return api.send(id, "Who do you want to pay? Type their name."); }
      const p = store.payee(s.household, pick);
      if (!p) return;
      convo.set(id, { ...s, step: "amount", payeeId: p.id, payeeName: p.name });
      return api.send(id, `How much do you want to pay ${p.name}? (in US dollars, for example 0.01)`);
    }
    if (data === "skip_context") {
      await api.answer(q.id);
      const s = convo.get(id);
      if (s?.step === "context") return submitPay(q.from, s, "");
      return;
    }
    if (data.startsWith("ap:") || data.startsWith("dn:")) {
      const decisionId = data.slice(3);
      const d = store.decision(decisionId);
      const h = d && store.household(d.householdId);
      if (!h || !h.family.some((m) => m.telegramId === id)) return api.answer(q.id, "Only family can approve this.");
      const out = await familyDecide(decisionId, data.startsWith("ap:") ? "approve" : "deny", q.from.first_name || "family");
      await api.editButtons(q.message.chat.id, q.message.message_id);
      return api.answer(q.id, out.error ? `Already handled (${out.error}).` : data.startsWith("ap:") ? "Approved" : "Declined");
    }
    return api.answer(q.id);
  }

  async function startPay(m, membership) {
    const id = String(m.from.id);
    if (!membership) return api.send(id, "Ask your family to set up Vetus for you first. They can start with /start.");
    const h = membership.household;
    convo.set(id, { step: "payee", household: h });
    const rows = h.payees.map((p) => [{ text: p.name, callback_data: `payee:${p.id}` }]);
    rows.push([{ text: "Someone else", callback_data: "payee:__other" }]);
    return api.send(id, "Who would you like to pay?", { reply_markup: { inline_keyboard: rows } });
  }

  async function onConvo(m, s, text) {
    const id = String(m.from.id);
    if (s.step === "elder_name") {
      const elderName = text.slice(0, 40);
      const h = store.createHousehold({ elderName, familyMember: { telegramId: id, name: nameOf(m.from) } });
      convo.delete(id);
      return api.send(id, `Done. ${elderName} is protected by Vetus.\n\n${invitesText(h)}\n\nNext, add the people ${elderName} pays with /addpayee, and check the limits with /limits.\n\nLive payments start switched off. Share your household code (${h.code}) with the Vetus team to switch them on.`);
    }
    if (s.step === "other_name") {
      convo.set(id, { ...s, step: "amount", payeeId: null, payeeName: text.slice(0, 80) });
      return api.send(id, `How much do you want to pay ${text}? (in US dollars, for example 0.01)`);
    }
    if (s.step === "amount") {
      const amount = Number(text.replace(/[$,\s]/g, ""));
      if (!(amount > 0)) return api.send(id, "Please type just the amount, for example 0.01");
      convo.set(id, { ...s, step: "memo", amount });
      return api.send(id, "What is it for?");
    }
    if (s.step === "memo") {
      convo.set(id, { ...s, step: "context", memo: text.slice(0, 300) });
      return api.send(id, "Did someone send you a message or call you about this payment? If so, paste or forward what they said. If not, tap Skip.", {
        reply_markup: { inline_keyboard: [[{ text: "Skip", callback_data: "skip_context" }]] },
      });
    }
    if (s.step === "context") return submitPay(m.from, s, text);
    convo.delete(id);
  }

  async function submitPay(from, s, context) {
    const id = String(from.id);
    convo.delete(id);
    await api.send(id, "Checking this payment… one moment.");
    const membership = store.forTelegramUser(id);
    const d = await handlePaymentRequest(s.household, { payeeId: s.payeeId, payeeName: s.payeeName, amount: s.amount, memo: s.memo, context }, { source: "telegram", requestedBy: id });
    // Family members paying on someone's behalf hear the outcome here; elders hear it through notifications.
    if (membership?.role === "family") {
      if (d.verdict === "BLOCK") return api.send(id, `🔴 Blocked. ${d.familyMessage}`);
      if (d.verdict === "HOLD") return api.send(id, `🟡 Held for family approval. ${d.familyMessage}`);
    }
  }

  async function runCheck(m, text) {
    const id = String(m.from.id);
    if (!store.bump(`check:${id}`, config.dailyCheckLimit)) {
      return api.send(id, "You've reached today's limit for message checks. Please try again tomorrow, and don't act on anything urgent until you've spoken to family.");
    }
    await api.send(id, "Checking… one moment.");
    const membership = store.forTelegramUser(id);
    const c = await checkMessage(membership?.household ?? null, text, { requestedBy: id });
    const r = c.reasoning || {};
    const flags = r.redFlags?.length ? `\n\nWarning signs: ${r.redFlags.join(", ")}` : "";
    const pattern = r.scamPattern ? ` (${r.scamPattern})` : "";
    return api.send(id, `${CHECK_HEAD[c.verdict]}${pattern}\n\n${c.elderMessage}${flags}`);
  }

  return { init, handleUpdate };
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

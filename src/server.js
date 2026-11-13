import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, bootstrapKpass } from "./config.js";
import { store } from "./store.js";
import { handlePaymentRequest, checkMessage, familyDecide, liveMode } from "./vet.js";
import { runRules, stricter } from "./rules.js";
import { servVet } from "./serv.js";
import { telegramApi, poll } from "./telegram.js";
import { createBot } from "./bot.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

function send(res, code, body, type = "application/json") {
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (type === "application/json") headers["Access-Control-Allow-Origin"] = "*";
  res.writeHead(code, headers);
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
const page = async (res, file) => send(res, 200, await readFile(resolve(publicDir, file), "utf8"), "text/html; charset=utf-8");
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 32_000) throw Object.assign(new Error("body too large"), { code: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw Object.assign(new Error("invalid JSON"), { code: 400 });
  }
}

// What a household dashboard sees. Never includes the invite code or payee endpoints.
function publicState(h) {
  return {
    household: { elderName: h.elderName, code: h.demo ? null : h.code, family: h.family.map((m) => m.name), demo: h.demo },
    policy: h.policy,
    payees: h.payees.map(({ id, name, category, trusted, typicalAmount, kind }) => ({ id, name, category, trusted, typicalAmount, kind })),
    decisions: store.decisions(h.id).slice(0, 100),
    checks: store.checks(h.id).slice(0, 50),
    spentToday: store.spentToday(h.id),
    mode: liveMode(h),
    model: config.servModel,
    bot: config.botUsername || null,
  };
}

export function createApp({ onTelegramUpdate, webhookSecret } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
        return res.end();
      }
      if (req.method === "GET" && path === "/") return page(res, "landing.html");
      if (req.method === "GET" && (path === "/demo" || /^\/h\/[\w-]+$/.test(path))) return page(res, "index.html");
      // Telegram webhook: Telegram posts updates here, which also wakes a sleeping free-tier server.
      if (req.method === "POST" && path === "/telegram/webhook" && onTelegramUpdate) {
        if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) return send(res, 401, { error: "bad secret" });
        const update = await readJson(req);
        send(res, 200, { ok: true }); // answer fast; handle after
        return void onTelegramUpdate(update).catch((e) => console.error("[vetus] bot update failed:", e.message));
      }
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, bot: config.botUsername || null });
      if (req.method === "GET" && path === "/api/info") return send(res, 200, { bot: config.botUsername || null, model: config.servModel });

      // Public agent API: any AI agent can ask Vetus to vet a payment before it pays. Nothing is paid.
      if (req.method === "POST" && path === "/api/vet") {
        if (!store.bump(`vet:${clientIp(req)}`, 50)) return send(res, 429, { error: "daily limit reached for this address" });
        const b = await readJson(req);
        const request = {
          payeeName: String(b.payee || b.payeeName || "Unknown payee").slice(0, 80),
          amount: Number(b.amount),
          memo: String(b.memo || "").slice(0, 300),
          context: String(b.context || "").slice(0, 2000),
        };
        const policy = { perPaymentLimit: Number(b.limits?.perPayment ?? 50), dailyLimit: Number(b.limits?.daily ?? 200), holdNewPayees: !!b.payeeIsNew };
        const trusted = b.payeeTrusted ? { name: request.payeeName, category: b.payeeCategory || "known payee", trusted: true, typicalAmount: b.typicalAmount } : null;
        const rules = runRules({ request, payee: trusted, policy, spentToday: Number(b.spentToday || 0), quotedAmount: b.quotedAmount ?? null });
        let reasoning, verdict = rules.verdict;
        try {
          reasoning = await servVet({ request, payee: trusted, policy, ruleChecks: rules.checks, spentToday: Number(b.spentToday || 0) });
          verdict = stricter(verdict, reasoning.verdict);
        } catch (e) {
          reasoning = { error: e.message };
          verdict = stricter(verdict, "HOLD");
        }
        const { raw, usage, ...shown } = reasoning;
        return send(res, 200, { verdict, pay: verdict === "APPROVE", rules: rules.checks, reasoning: shown });
      }

      // Public message check, used by the landing page "try it" box.
      if (req.method === "POST" && path === "/api/check") {
        if (!store.bump(`checkip:${clientIp(req)}`, 20)) return send(res, 429, { error: "daily limit reached, please try tomorrow" });
        const b = await readJson(req);
        const text = String(b.text || "").trim();
        if (!text) return send(res, 400, { error: "text is required" });
        const c = await checkMessage(null, text);
        const { raw, usage, ...shown } = c.reasoning || {};
        return send(res, 200, { verdict: c.verdict, elderMessage: c.elderMessage, familyMessage: c.familyMessage, reasoning: shown });
      }

      // Household dashboard API. The token in the path is the household's secret.
      const hm = path.match(/^\/api\/h\/([\w-]+)(\/.*)?$/);
      if (hm) {
        const h = hm[1] === "demo" ? store.household("demo") : store.byToken(hm[1]);
        if (!h) return send(res, 404, { error: "household not found" });
        const sub = hm[2] || "";
        if (req.method === "GET" && sub === "/state") return send(res, 200, publicState(h));
        if (req.method === "POST" && sub === "/pay") {
          if (!store.bump(`pay:${h.id}:${clientIp(req)}`, h.demo ? 40 : 200)) return send(res, 429, { error: "daily limit reached" });
          return send(res, 200, await handlePaymentRequest(h, await readJson(req), { source: "dashboard" }));
        }
        const dm = sub.match(/^\/decisions\/([\w-]+)\/(approve|deny)$/);
        if (req.method === "POST" && dm) {
          const d = store.decision(dm[1]);
          if (!d || d.householdId !== h.id) return send(res, 404, { error: "not found" });
          const out = await familyDecide(dm[1], dm[2], "family (dashboard)");
          return send(res, out?.code || 200, out);
        }
        if (req.method === "POST" && sub === "/reset" && h.demo) {
          store.resetDemo();
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, Number.isInteger(e.code) ? e.code : 500, { error: e.message });
    }
  });
}

// Start everything when run directly (npm start).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (bootstrapKpass()) console.log("[vetus] kpass config written from environment");
  const useWebhook = config.telegramToken && config.publicUrl.startsWith("https://") && process.env.TELEGRAM_MODE !== "polling";
  const api = config.telegramToken ? telegramApi() : null;
  const bot = api ? createBot(api) : null;
  const webhookSecret = createHash("sha256").update(`vetus:${config.telegramToken}`).digest("hex").slice(0, 48);

  createApp(useWebhook ? { onTelegramUpdate: bot.handleUpdate, webhookSecret } : {}).listen(config.port, () => {
    console.log(`[vetus] running on ${config.publicUrl}${config.dryRun ? " (dry run, no money moves)" : ""}`);
  });

  if (!bot) {
    console.log("[vetus] TELEGRAM_BOT_TOKEN not set; bot disabled");
  } else {
    bot.init()
      .then(async (name) => {
        config.botUsername = name;
        if (useWebhook) {
          await api.call("setWebhook", { url: `${config.publicUrl}/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ["message", "callback_query"] });
          console.log(`[vetus] Telegram bot @${name} is listening (webhook)`);
        } else {
          await api.call("deleteWebhook", {});
          console.log(`[vetus] Telegram bot @${name} is listening (polling)`);
          await poll(api, bot.handleUpdate);
        }
      })
      .catch((e) => console.error("[vetus] Telegram bot failed to start:", e.message));
  }
}

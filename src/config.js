import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// Minimal .env loader so the project has zero dependencies.
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      const quoted = /^["'].*["']$/.test(m[2]);
      // Strip inline comments ("KEY=value  # note") unless the value is quoted.
      process.env[m[1]] = (quoted ? m[2] : m[2].replace(/\s+#.*$/, "").replace(/^#.*$/, "")).replace(/^["']|["']$/g, "");
    }
  }
}

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 4402),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4402}`).replace(/\/$/, ""),

  servApiKey: process.env.SERV_API_KEY || "",
  servBaseUrl: process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1",
  servModel: process.env.SERV_MODEL || "gpt-5.4-mini",
  servEffort: process.env.SERV_REASONING_EFFORT || "medium",

  kpassBin: process.env.KPASS_BIN || "kpass",
  kpassDir: process.env.KPASS_DIR || process.cwd(),
  walletChain: process.env.WALLET_CHAIN || "base",
  // Tried in order; public endpoints limit log searches, so Vetus falls back between them.
  baseRpcUrls: list(process.env.BASE_RPC_URL || "https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.llamarpc.com"),

  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramApi: process.env.TELEGRAM_API || "https://api.telegram.org",
  botUsername: process.env.TELEGRAM_BOT_USERNAME || "",
  // Telegram user ids allowed to switch real payments on for a household.
  admins: list(process.env.ADMIN_TELEGRAM_IDS),

  // Where households and decisions are saved. Uses VETUS_DATA if set; otherwise a mounted disk
  // at /var/data if one exists (Render persistent disk); otherwise ./data for local runs.
  dataFile: process.env.VETUS_DATA || (existsSync("/var/data") ? "/var/data/vetus.json" : resolve(process.cwd(), "data", "vetus.json")),
  // Set DRY_RUN=1 to vet everything without moving money anywhere.
  dryRun: process.env.DRY_RUN === "1",
  // Free scam checks per person per day, to protect SERV credits.
  dailyCheckLimit: Number(process.env.DAILY_CHECK_LIMIT || 30),
};

// On a server there is no browser for `kpass login`. Supply the saved kpass files
// (base64 of ~/.kite-passport/config.json, agent.json and sessions.json) through environment variables.
// They are written both to the home folder and the project folder, since kpass reads either.
export function bootstrapKpass() {
  const files = {
    "config.json": process.env.KPASS_CONFIG_B64,
    "agent.json": process.env.KPASS_AGENT_B64,
    "sessions.json": process.env.KPASS_SESSIONS_B64,
  };
  const dirs = [...new Set([join(homedir(), ".kite-passport"), join(config.kpassDir, ".kite-passport")])];
  let wrote = 0;
  for (const [name, b64] of Object.entries(files)) {
    if (!b64) continue;
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, name), Buffer.from(b64.trim(), "base64"), { mode: 0o600 });
    }
    wrote++;
  }
  return wrote;
}

if (!config.servApiKey) {
  console.warn("[vetus] SERV_API_KEY is not set. Every payment will be held for family review.");
}

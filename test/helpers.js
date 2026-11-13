// Fakes for SERV, kpass and Telegram so the whole system can be tested without spending anything.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dir = mkdtempSync(join(tmpdir(), "vetus-test-"));
export const kpassLog = join(dir, "kpass.log");

// Fake SERV: BLOCKs gift cards and injection attempts, HOLDs "neighbour", APPROVEs the rest.
export function verdictFor(text) {
  const scam = /gift card|SYSTEM NOTE|bitcoin atm/i.test(text);
  const odd = /neighbou?r/i.test(text);
  return JSON.stringify({
    verdict: scam ? "BLOCK" : odd ? "HOLD" : "APPROVE",
    risk: scam ? 96 : odd ? 35 : 3,
    scam_pattern: scam ? "grandparent emergency" : "none",
    red_flags: scam ? ["gift cards", "secrecy"] : [],
    steps: [{ check: "WHO", finding: "checked" }],
    elder_message: scam ? "Please call your family first." : "All good.",
    family_message: scam ? "Blocked a scam." : odd ? "Unusual, please check." : "Routine.",
  });
}

export async function startFakeServ() {
  const calls = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      calls.push({ url: req.url, body });
      if (req.url === "/responses" && /FAIL_RESPONSES/.test(body.input)) { res.writeHead(400); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/responses") {
        return res.end(JSON.stringify({ model: "fake-serv", output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "**Weighing it**\n\nChecked payee, method and pressure." }] },
          { type: "function_call", name: "submit_verdict", call_id: "c1", arguments: verdictFor(body.input) },
        ] }));
      }
      res.end(JSON.stringify({ model: "fake-serv", choices: [{ message: { content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "submit_verdict", arguments: verdictFor(body.messages[1].content) } }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}

// Fake kpass: logs its arguments and answers like the real CLI.
export function makeFakeKpass() {
  const path = join(dir, "kpass");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(kpassLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "wallet" && args[1] === "send" && require("fs").existsSync(${JSON.stringify(join(dir, "passkey-mode"))})) {
  console.log(JSON.stringify({ status: "approval_required", request_id: "wsr_test",
    hint: "Wallet send needs passkey approval. Show this approval URL to the user verbatim: https://agentpassport.ai/wallet/send/approve?token=wsr_test" }));
} else if (args[0] === "wallet" && args[1] === "send") {
  console.log(JSON.stringify({ status: "success", chain: "base", transaction: "0x" + "b".repeat(64) }));
} else {
  console.log(JSON.stringify({ status: "success", payment: { amount: "10000", network: "eip155:8453",
    payment_response: { success: true, transaction: "0x" + "a".repeat(64), payer: "0xme" } },
    usage: { period: { remaining: "2.98" } }, user_message: "Paid USD 0.01" }));
}
`);
  chmodSync(path, 0o755);
  return path;
}

export const kpassCalls = () => {
  try { return readFileSync(kpassLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
};

// Fake Telegram API: records every message, answers callbacks.
export function fakeTelegram() {
  const sent = [];
  let msgId = 1;
  return {
    sent,
    call: async () => [],
    getMe: async () => ({ username: "vetus_test_bot" }),
    send: async (chatId, text, extra = {}) => { sent.push({ chatId: String(chatId), text, extra, message_id: msgId }); return { message_id: msgId++ }; },
    answer: async () => {},
    editButtons: async () => {},
    setCommands: async () => {},
    to: (chatId) => sent.filter((m) => m.chatId === String(chatId)),
    last: (chatId) => sent.filter((m) => m.chatId === String(chatId)).at(-1),
    clear: () => sent.splice(0),
  };
}

export const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

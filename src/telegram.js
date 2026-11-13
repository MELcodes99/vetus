import { config } from "./config.js";

// A tiny Telegram Bot API client. No dependencies, long polling, plain-text messages.
export function telegramApi(token = config.telegramToken, base = config.telegramApi) {
  async function call(method, params = {}) {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
    return json.result;
  }
  return {
    call,
    getMe: () => call("getMe"),
    send: (chatId, text, extra = {}) =>
      call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra }),
    answer: (id, text) => call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {}),
    editButtons: (chatId, messageId, reply_markup = { inline_keyboard: [] }) =>
      call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup }).catch(() => {}),
    setCommands: (commands) => call("setMyCommands", { commands }).catch(() => {}),
  };
}

// Poll for updates forever, handing each one to the bot. Survives network errors.
export async function poll(api, onUpdate) {
  let offset = 0;
  for (;;) {
    try {
      const updates = await api.call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await onUpdate(u).catch((e) => console.error("[vetus] bot update failed:", e.message));
      }
    } catch (e) {
      console.error("[vetus] telegram poll:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

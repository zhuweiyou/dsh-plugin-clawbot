import crypto from "node:crypto";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_ILINK_BOT_TYPE = "3";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = 132102;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35e3;
const DEFAULT_API_TIMEOUT_MS = 15e3;
const DEFAULT_CONFIG_TIMEOUT_MS = 1e4;
const DEFAULT_BOT_AGENT = "dsh-plugin-clawbot/1.0.0";
const MessageType = { USER: 1, BOT: 2 };
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
class WeixinApiError extends Error {
  constructor(message, { ret, errcode, errmsg } = {}) {
    super(message);
    this.name = "WeixinApiError";
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}
function buildCommonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION)
  };
}
function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
    ...token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}
  };
}
function createWeixinClient(opts = {}) {
  const baseUrl = ensureTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
  const token = opts.token;
  const log = opts.log ?? (() => {
  });
  const botAgent = sanitizeBotAgent(opts.botAgent);
  const channelVersion = opts.channelVersion ?? "2.4.6";
  const apiTimeoutMs = opts.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const longPollTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const baseInfo = { channel_version: channelVersion, bot_agent: botAgent };
  async function post(endpoint, body, timeoutMs, useToken = true) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(new URL(endpoint, baseUrl), {
        method: "POST",
        headers: useToken ? buildHeaders(token) : buildHeaders(void 0),
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(t);
      if (err.name === "AbortError") throw new WeixinApiError(`request timeout after ${timeoutMs}ms`, {});
      throw err;
    }
    clearTimeout(t);
    return parseResponse(endpoint, res);
  }
  async function get(endpoint, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(new URL(endpoint, baseUrl), {
        method: "GET",
        headers: buildCommonHeaders(),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(t);
      if (err.name === "AbortError") throw new WeixinApiError(`request timeout after ${timeoutMs}ms`, {});
      throw err;
    }
    clearTimeout(t);
    return parseResponse(endpoint, res);
  }
  async function parseResponse(endpoint, res) {
    const raw = await res.text();
    if (!res.ok) throw new WeixinApiError(`${endpoint} HTTP ${res.status}: ${raw.slice(0, 300)}`, {});
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new WeixinApiError(`${endpoint} non-JSON response: ${raw.slice(0, 300)}`, {});
    }
    return parsed;
  }
  async function getUpdates(getUpdatesBuf = "", options = {}) {
    const timeoutMs = options.timeoutMs ?? longPollTimeoutMs;
    try {
      const resp = await post("ilink/bot/getupdates", {
        get_updates_buf: getUpdatesBuf ?? "",
        base_info: baseInfo
      }, timeoutMs);
      log(`getupdates: ret=${resp.ret} msgs=${resp.msgs?.length ?? 0} bufLen=${resp.get_updates_buf?.length ?? 0}`);
      return resp;
    } catch (err) {
      if (err instanceof WeixinApiError && err.message.includes("timeout")) {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw err;
    }
  }
  async function sendText(toUserId, text, contextToken) {
    const resp = await post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: crypto.randomUUID(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        ...contextToken ? { context_token: contextToken } : {}
      },
      base_info: baseInfo
    }, apiTimeoutMs);
    if (resp.ret && resp.ret !== 0) {
      throw new WeixinApiError(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`, resp);
    }
    log(`sendmessage ok to=${toUserId} chars=${text.length}`);
  }
  async function getConfig(ilinkUserId, contextToken) {
    return post("ilink/bot/getconfig", {
      ilink_user_id: ilinkUserId,
      ...contextToken ? { context_token: contextToken } : {},
      base_info: baseInfo
    }, DEFAULT_CONFIG_TIMEOUT_MS);
  }
  async function sendTyping(ilinkUserId, typingTicket, status = 1) {
    await post("ilink/bot/sendtyping", {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo
    }, DEFAULT_CONFIG_TIMEOUT_MS);
  }
  async function notifyStart() {
    return post("ilink/bot/msg/notifystart", { base_info: baseInfo }, DEFAULT_CONFIG_TIMEOUT_MS);
  }
  async function notifyStop() {
    try {
      return await post("ilink/bot/msg/notifystop", { base_info: baseInfo }, DEFAULT_CONFIG_TIMEOUT_MS);
    } catch (err) {
      log(`notifystop failed (ignored): ${String(err)}`);
      return void 0;
    }
  }
  async function getBotQrcode(localTokenList = []) {
    const resp = await post(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_ILINK_BOT_TYPE)}`,
      { local_token_list: localTokenList },
      DEFAULT_API_TIMEOUT_MS,
      false
    );
    return resp;
  }
  async function getQrcodeStatus(qrcode, verifyCode, options = {}) {
    const timeoutMs = options.timeoutMs ?? 3e4;
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      return await get(endpoint, timeoutMs);
    } catch (err) {
      if (err instanceof WeixinApiError && err.message.includes("timeout")) {
        return { status: "wait" };
      }
      return { status: "wait" };
    }
  }
  return { getUpdates, sendText, getConfig, sendTyping, notifyStart, notifyStop, getBotQrcode, getQrcodeStatus };
}
function messageBody(msg) {
  const items = msg?.item_list ?? [];
  for (const item of items) {
    if (item?.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = messageBody({ item_list: [ref.message_item] });
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[\u5F15\u7528: ${parts.join(" | ")}]
${text}`;
    }
    if (item?.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}
function isMediaItem(item) {
  return [MessageItemType.IMAGE, MessageItemType.VIDEO, MessageItemType.FILE, MessageItemType.VOICE].includes(item?.type);
}
function sanitizeBotAgent(raw) {
  if (!raw || typeof raw !== "string") return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;
  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const tokens = trimmed.split(/\s+/).filter((tok) => productRe.test(tok));
  if (!tokens.length) return DEFAULT_BOT_AGENT;
  const joined = tokens.join(" ");
  return Buffer.byteLength(joined, "utf-8") <= 256 ? joined : DEFAULT_BOT_AGENT;
}
export {
  DEFAULT_BASE_URL,
  DEFAULT_ILINK_BOT_TYPE,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  MessageItemType,
  MessageState,
  MessageType,
  WeixinApiError,
  createWeixinClient,
  messageBody,
  sanitizeBotAgent
};

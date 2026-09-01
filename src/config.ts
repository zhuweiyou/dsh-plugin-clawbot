import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}
function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return void 0;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return void 0;
  }
}
function weixinStateDir() {
  return path.join(OPENCLAW_HOME, "openclaw-weixin");
}
function weixinAccountsDir() {
  return path.join(weixinStateDir(), "accounts");
}
function listAccountIds() {
  const ids = readJsonIfExists(path.join(weixinStateDir(), "accounts.json"));
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.trim()) : [];
}
function loadAccount(accountId) {
  const file = path.join(weixinAccountsDir(), `${accountId}.json`);
  const data = readJsonIfExists(file);
  if (data) return { accountId, ...data };
  if (accountId.endsWith("-im-bot")) {
    const legacy = readJsonIfExists(path.join(weixinAccountsDir(), `${accountId.slice(0, -7)}@im.bot.json`));
    if (legacy) return { accountId, ...legacy };
  }
  return void 0;
}
function discoverAccount(preferId) {
  const ids = listAccountIds();
  const candidates = preferId ? ids.filter((id2) => id2 === preferId) : ids;
  const id = candidates[candidates.length - 1] ?? ids[ids.length - 1];
  if (!id) return void 0;
  return loadAccount(id);
}
function registerAccountId(accountId) {
  const dir = weixinStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = listAccountIds();
  if (existing.includes(accountId)) return;
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify([...existing, accountId], null, 2), "utf-8");
}
function unregisterAccountId(accountId) {
  const existing = listAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(path.join(weixinStateDir(), "accounts.json"), JSON.stringify(updated, null, 2), "utf-8");
  }
}
function saveAccount(update) {
  const dir = weixinAccountsDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = loadAccount(update.accountId) ?? {};
  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId = update.userId !== void 0 ? update.userId.trim() || void 0 : existing.userId?.trim() || void 0;
  const data = {
    ...token ? { token, savedAt: (/* @__PURE__ */ new Date()).toISOString() } : {},
    ...baseUrl ? { baseUrl } : {},
    ...userId ? { userId } : {}
  };
  const filePath = path.join(dir, `${update.accountId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 384);
  } catch {
  }
  registerAccountId(update.accountId);
}
function clearAccount(accountId) {
  const dir = weixinAccountsDir();
  for (const suffix of ["json", "sync.json", "context-tokens.json"]) {
    try {
      fs.unlinkSync(path.join(dir, `${accountId}.${suffix}`));
    } catch {
    }
  }
  unregisterAccountId(accountId);
}
function clearStaleAccountsForUserId(currentAccountId, userId) {
  if (!userId) return;
  for (const id of listAccountIds()) {
    if (id === currentAccountId) continue;
    const data = loadAccount(id);
    if (data?.userId?.trim() === userId) clearAccount(id);
  }
}
function localTokenList() {
  const ids = listAccountIds();
  const tokens = [];
  for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i--) {
    const token = loadAccount(ids[i])?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}
function loadConfig(cliOverrides = {}) {
  const configFile = cliOverrides.config;
  const fileConfig = configFile ? readJsonIfExists(expandHome(configFile)) : readJsonIfExists(path.join(process.cwd(), "config.json"));
  const file = fileConfig ?? {};
  const env = process.env;
  const dsh = {
    baseUrl: env.DSH_BASE_URL ?? file.dsh?.baseUrl ?? "http://127.0.0.1:3080",
    cwd: env.DSH_CWD ?? file.dsh?.cwd ?? process.cwd(),
    agentPreset: env.DSH_AGENT_PRESET ?? file.dsh?.agentPreset
  };
  const weixin = {
    baseUrl: env.WECHAT_BASE_URL ?? file.weixin?.baseUrl,
    token: env.WECHAT_BOT_TOKEN ?? env.CLAWBOT_TOKEN ?? file.weixin?.token,
    accountId: env.CLAWBOT_ACCOUNT_ID ?? file.weixin?.accountId,
    allowFrom: parseList(env.CLAWBOT_ALLOW_FROM) ?? file.weixin?.allowFrom ?? [],
    botAgent: file.weixin?.botAgent
  };
  let discovered;
  try {
    discovered = discoverAccount(weixin.accountId);
  } catch {
    discovered = void 0;
  }
  if (weixin.baseUrl === void 0) weixin.baseUrl = discovered?.baseUrl;
  if (weixin.token === void 0) weixin.token = discovered?.token;
  if (weixin.accountId === void 0) weixin.accountId = discovered?.accountId;
  const bridge = {
    stateDir: expandHome(env.CLAWBOT_STATE_DIR ?? file.bridge?.stateDir ?? path.join(os.homedir(), ".dsh-clawbot")),
    typing: file.bridge?.typing ?? false,
    replyTimeoutMs: file.bridge?.replyTimeoutMs ?? 10 * 60 * 1e3,
    pollTimeoutMs: file.bridge?.pollTimeoutMs ?? 35e3,
    logLevel: env.CLAWBOT_LOG_LEVEL ?? file.bridge?.logLevel ?? "info"
  };
  return { dsh, weixin, bridge, discovered };
}
function parseList(raw) {
  if (!raw) return void 0;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
export {
  OPENCLAW_HOME,
  clearAccount,
  clearStaleAccountsForUserId,
  discoverAccount,
  expandHome,
  listAccountIds,
  loadAccount,
  loadConfig,
  localTokenList,
  registerAccountId,
  saveAccount,
  unregisterAccountId,
  weixinAccountsDir,
  weixinStateDir
};

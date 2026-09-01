/**
 * ClawbotManager — owns the WeChat ⇄ DSH bridge lifecycle and the QR-code
 * account (re)binding flow inside the DSH host.
 *
 * Responsibilities:
 *   - discover/load the bound ClawBot account (token, baseUrl, userId)
 *   - run the bridge: getupdates long-poll → DSH session.prompt → mux
 *     turn watcher → sendmessage reply (one DSH session per WeChat peer)
 *   - hot-swap the WeChat client after a successful re-login
 *   - QR login state machine (start / poll / refresh / verify-code / confirm)
 *   - unbind an account
 *   - expose a status view + a bounded log buffer for the web UI
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { createWeixinClient, messageBody, MessageType } from './weixin.js';
import { createDshClient } from './dsh.js';
import { ChannelState } from './state.js';
import { OPENCLAW_HOME, discoverAccount, saveAccount, clearAccount, clearStaleAccountsForUserId, localTokenList } from './config.js';

const STALE_TOKEN_ERRCODE = -14; // session timeout → token expired, QR re-login needed
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const STALE_TOKEN_PAUSE_MS = 10 * 60 * 1000;
const DEDUPE_CAP = 2000;
const MAX_QR_REFRESH = 3;
const LOG_CAP = 200;

export function sessionIdForPeer(peerKey) {
  return `clawbot-${crypto.createHash('sha1').update(peerKey).digest('hex').slice(0, 16)}`;
}

function peerKeyOf(msg) {
  if (msg.group_id) return `group:${msg.group_id}`;
  return msg.from_user_id ?? '';
}

function extractAssistantText(event) {
  const data = event?.data;
  const content = data?.message?.content ?? data?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Return the name of an interactive model tool that cannot be answered in WeChat. */
function extractInteractiveTool(event) {
  const data = event?.data;
  const content = data?.message?.content ?? data?.content;
  if (!Array.isArray(content)) return '';
  const block = content.find((item) => item?.type === 'tool-call'
    && (item.name === 'ask_user_question' || item.name === 'request_user_input'));
  return block?.name ?? '';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export class ClawbotManager {
  /**
   * @param {object} cfg normalized config from loadConfig()
   * @param {object} [opts]
   * @param {(level: 'debug'|'info'|'warn'|'error', msg: string) => void} [opts.log]
   * @param {ReturnType<typeof createDshClient>} [opts.dsh] injected DSH client (tests)
   * @param {(acct: object) => ReturnType<typeof createWeixinClient>} [opts.weixinFactory] injected WeChat client factory (tests)
   * @param {(handler: (frame: object) => void) => (() => void)|void} [opts.eventBus] in-process
   *   session/event source (host plugins) — replaces the WebSocket mux downlink
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.dshCfg = cfg.dsh;
    this.wxCfg = cfg.weixin;
    this.brCfg = cfg.bridge;
    this.eventBus = opts.eventBus;
    this.logFn = opts.log ?? ((level, msg) => {
      if (level === 'debug') return;
      console[level === 'error' ? 'error' : 'log'](`[${new Date().toISOString()}] [${level}] ${msg}`);
    });
    this.dsh = opts.dsh ?? createDshClient(this.dshCfg.baseUrl, { log: (l) => this.log('debug', `[dsh] ${l}`) });
    this.weixinFactory = opts.weixinFactory ?? ((acct) => createWeixinClient({
      baseUrl: acct.baseUrl ?? this.wxCfg.baseUrl,
      token: acct.token,
      botAgent: this.wxCfg.botAgent,
      longPollTimeoutMs: this.brCfg.pollTimeoutMs,
      log: (l) => this.log('debug', `[weixin] ${l}`),
    }));

    this.acct = null;           // current resolved account
    this.weixin = null;         // current WeChat client (hot-swappable)
    this.state = null;          // ChannelState for the current account
    this.abort = new AbortController();
    this.paused = false;        // poll pause (stale token / no account)
    this.getUpdatesBuf = '';

    this.watchers = new Map();  // sessionId -> turn watcher
    this.peerQueues = new Map(); // peerKey -> FIFO promise
    this.seen = new Set();
    this.contextTokens = {};

    this.logs = [];             // ring buffer for the UI
    this.phase = 'starting';    // starting|running|needs-login|stopped
    this.lastPollAt = null;
    this.lastError = null;

    // Login state machine.
    this.login = {
      active: false,
      qrcode: null,
      qrcodeUrl: null,
      currentApiBaseUrl: null,
      startedAt: 0,
      status: null,
      pendingVerifyCode: null,
      refreshCount: 0,
      error: null,
    };
  }

  log(level, msg) {
    this.logFn(level, msg);
    if (level !== 'debug') {
      this.logs.push({ at: Date.now(), level, msg });
      if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
    }
  }

  /** Resolve the account to run: explicit config token wins, else the store. */
  resolveAccount() {
    if (this.wxCfg.token) {
      return {
        accountId: this.wxCfg.accountId ?? 'configured',
        token: this.wxCfg.token,
        baseUrl: this.wxCfg.baseUrl,
      };
    }
    return discoverAccount(this.wxCfg.accountId) ?? null;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start() {
    this.acct = this.resolveAccount();
    if (!this.acct?.token) {
      this.phase = 'needs-login';
      this.log('warn', 'no bound WeChat account — open the ClawBot panel in DSH settings to scan a QR code');
      // Keep the mux connected so DSH stays warm; polling stays paused.
      this.#startMux();
      return;
    }
    this.log('info', `channel starting: account=${this.acct.accountId} base=${this.acct.baseUrl ?? this.wxCfg.baseUrl} dsh=${this.dshCfg.baseUrl} cwd=${this.dshCfg.cwd}`);
    this.#adoptAccount(this.acct);
    this.phase = 'running';
    this.#startMux();
    await this.#ensurePolling();
    try {
      await this.weixin.notifyStart();
    } catch (err) {
      this.log('warn', `notifystart failed: ${String(err)}`);
    }
  }

  /**
   * Wait until the DSH HTTP API is reachable. The plugin runs inside the DSH
   * host, so during startup the /api gateway may not have finished wiring up.
   * Probing with a cheap read-only call avoids 404-style transport races on
   * the first inbound messages.
   */
  async #awaitDshReady() {
    if (this.eventBus) return; // in-process event bus implies we're in the host
    const deadline = Date.now() + 60_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      try {
        await this.dsh.listSessions();
        return;
      } catch {
        attempt += 1;
        await sleep(Math.min(250 * 2 ** (attempt - 1), 4000), this.abort.signal);
        if (this.abort.signal.aborted) return;
      }
    }
    this.log('warn', 'DSH API not reachable after 60s — continuing anyway');
  }

  /** Start the long-poll loop if an account is active and it isn't already running. */
  async #ensurePolling() {
    if (this.weixin && !this.pollLoopPromise) {
      await this.#awaitDshReady();
      if (this.weixin && !this.pollLoopPromise) {
        this.#startPollLoop();
      }
    }
  }

  async stop() {
    this.abort.abort();
    this.phase = 'stopped';
    this.pollLoopPromise = undefined; // allow a later resume() to restart polling
    if (this.weixin) {
      await this.weixin.notifyStop().catch(() => {});
    }
  }

  /** Adopt an account: swap the WeChat client + state and reset cursors. */
  #adoptAccount(acct) {
    this.acct = acct;
    this.weixin = this.weixinFactory(acct);
    this.state = new ChannelState(this.brCfg.stateDir, acct.accountId ?? 'default');
    this.contextTokens = this.state.loadContextTokens();
    this.seen.clear();
    const seed = path.join(OPENCLAW_HOME, 'openclaw-weixin', 'accounts', `${acct.accountId}.sync.json`);
    this.getUpdatesBuf = this.state.loadSyncBuf(seed);
    this.log('info', `account adopted ${acct.accountId} — sync buf ${this.getUpdatesBuf ? `resumed (${this.getUpdatesBuf.length}B)` : 'fresh'}`);
  }

  // ------------------------------------------------------------------
  // Mux event stream (reconnect loop)
  // ------------------------------------------------------------------

  #startMux() {
    this.dsh.openMux(
      (frame) => this.#onMuxFrame(frame),
      this.abort.signal,
      (status, detail) => this.log('info', `[dsh] mux ${status}${detail ? ` (${detail})` : ''}`),
      this.eventBus ? { eventBus: this.eventBus } : undefined,
    ).catch((err) => this.log('warn', `[dsh] mux stopped: ${String(err)}`));
  }

  #onMuxFrame(frame) {
    if (frame.type !== 'session/event') return;
    const sessionId = frame.sessionId;
    const event = frame.event;
    if (!sessionId || !event) return;
    const watcher = this.watchers.get(sessionId);
    if (!watcher) return;
    if (event.type === 'assistant/message') {
      const text = extractAssistantText(event);
      if (text) watcher.texts.push(text);
      const tool = extractInteractiveTool(event);
      if (tool) {
        this.log('warn', `[${sessionId}] ${tool} requires an interactive UI; cancelling for WeChat`);
        watcher.finalize('unsupported-interaction');
        this.dsh.cancel(sessionId).catch((err) => {
          this.log('debug', `[dsh] cancel ${sessionId} after unsupported tool failed: ${String(err)}`);
        });
      }
    } else if (event.type === 'turn/end') {
      watcher.finalize('turn-end');
    }
  }

  // ------------------------------------------------------------------
  // WeChat long-poll loop
  // ------------------------------------------------------------------

  #startPollLoop() {
    if (this.pollLoopPromise) return; // already running
    const loop = (async () => {
      let consecutiveFailures = 0;
      let nextTimeoutMs = this.brCfg.pollTimeoutMs;
      while (!this.abort.signal.aborted) {
        if (this.paused || !this.weixin) {
          await sleep(2000, this.abort.signal);
          continue;
        }
        try {
          const resp = await this.weixin.getUpdates(this.getUpdatesBuf, { timeoutMs: nextTimeoutMs });
          if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
            nextTimeoutMs = resp.longpolling_timeout_ms;
          }
          const apiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
          if (apiError) {
            if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
              this.#onStaleToken();
              continue;
            }
            consecutiveFailures += 1;
            this.log('warn', `getupdates api error ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
            await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, this.abort.signal);
            continue;
          }
          consecutiveFailures = 0;
          this.lastPollAt = Date.now();
          if (resp.get_updates_buf) {
            this.getUpdatesBuf = resp.get_updates_buf;
            this.state.saveSyncBuf(this.getUpdatesBuf);
          }
          for (const msg of resp.msgs ?? []) {
            await this.#handleInbound(msg).catch((err) => this.log('error', `handleInbound failed: ${String(err)}`));
          }
        } catch (err) {
          if (this.abort.signal.aborted) break;
          consecutiveFailures += 1;
          this.lastError = String(err);
          this.log('warn', `getupdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, this.abort.signal);
        }
      }
    })();
    this.pollLoopPromise = loop;
  }

  #onStaleToken() {
    this.phase = 'needs-login';
    this.paused = true;
    this.lastError = 'WeChat token expired (errcode=-14)';
    this.log('error', 'WeChat token is stale (errcode=-14) — re-login via the ClawBot panel in DSH settings (扫码重新绑定)');
  }

  // ------------------------------------------------------------------
  // Inbound handling (per-peer FIFO, one DSH session per peer)
  // ------------------------------------------------------------------

  async #handleInbound(msg) {
    if (msg.message_type === MessageType.BOT) return; // our own echoes
    const dedupeId = msg.message_id ?? msg.seq;
    if (dedupeId !== undefined) {
      if (this.seen.has(dedupeId)) return;
      this.seen.add(dedupeId);
      if (this.seen.size > DEDUPE_CAP) {
        const first = this.seen.values().next().value;
        this.seen.delete(first);
      }
    }

    const fromUserId = msg.from_user_id ?? '';
    if (!fromUserId) return;
    if (this.wxCfg.allowFrom.length > 0 && !this.wxCfg.allowFrom.includes(fromUserId)) {
      this.log('info', `skipping message from non-allowlisted user ${fromUserId}`);
      return;
    }

    const text = messageBody(msg);
    const peerKey = peerKeyOf(msg);
    const contextToken = msg.context_token ?? this.contextTokens[fromUserId];
    if (contextToken) {
      this.contextTokens[fromUserId] = contextToken;
      this.state?.saveContextToken(fromUserId, contextToken);
    }

    this.log('info', `inbound from=${fromUserId} peer=${peerKey} items=${msg.item_list?.map((i) => i.type).join(',') ?? 'none'} textLen=${text.length}`);

    const prev = this.peerQueues.get(peerKey) ?? Promise.resolve();
    const next = prev.then(() => this.#processForPeer({ peerKey, fromUserId, text, contextToken }));
    this.peerQueues.set(peerKey, next.catch((err) => {
      this.log('error', `[${peerKey}] processForPeer failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }));

    if (this.brCfg.typing && contextToken) {
      this.weixin.getConfig(fromUserId, contextToken)
        .then((cfg) => cfg.typing_ticket && this.weixin.sendTyping(fromUserId, cfg.typing_ticket, 1))
        .catch(() => {});
    }
  }

  async #processForPeer({ peerKey, fromUserId, text, contextToken }) {
    if (text === '') {
      await this.#safeSend(fromUserId, '暂不支持该类型消息（仅支持文本）。', contextToken);
      return;
    }

    const trimmed = text.trim();
    if (trimmed === '/help') {
      await this.#safeSend(fromUserId, '可用命令：\n/new — 开启新会话\n/reset — 重置当前会话\n其他内容将发送给 DSH 智能体。', contextToken);
      return;
    }
    if (trimmed === '/new' || trimmed === '/reset') {
      this.state.removeSessionMapEntry(peerKey);
      const session = await this.dsh.createSession({
        cwd: this.dshCfg.cwd,
        sessionId: `clawbot-${crypto.randomUUID()}`,
        agentPreset: this.dshCfg.agentPreset,
      });
      this.state.saveSessionMapEntry(peerKey, session.sessionId, { cwd: this.dshCfg.cwd, agentPreset: session.agentPreset });
      await this.#safeSend(fromUserId, '已开启新会话。', contextToken);
      this.log('info', `[${peerKey}] new session ${session.sessionId}`);
      return;
    }

    let sessionId = this.state.loadSessionMap()[peerKey]?.sessionId;
    if (!sessionId) sessionId = await this.#ensureSession(peerKey);

    this.log('info', `[${peerKey}] -> dsh session ${sessionId}: ${text.slice(0, 120)}`);

    const watcher = this.#createWatcher(sessionId);
    try {
      await this.dsh.prompt(sessionId, text);
    } catch (err) {
      watcher.cancel();
      this.log('error', `[${peerKey}] prompt failed: ${String(err)}`);
      await this.#safeSend(fromUserId, `（DSH 调用失败：${err instanceof Error ? err.message : String(err)}）`, contextToken);
      return;
    }

    const reply = await watcher.promise;
    this.log('info', `[${peerKey}] <- reply ${reply.length} chars`);
    await this.#safeSend(fromUserId, reply, contextToken);
  }

  async #ensureSession(peerKey) {
    const deterministicId = sessionIdForPeer(peerKey);
    // DSH may be briefly unavailable right after host startup; retry with
    // backoff so a transient transport error doesn't drop the WeChat message.
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const session = await this.dsh.createSession({
          cwd: this.dshCfg.cwd,
          sessionId: deterministicId,
          agentPreset: this.dshCfg.agentPreset,
        });
        this.state.saveSessionMapEntry(peerKey, session.sessionId, { cwd: this.dshCfg.cwd, agentPreset: session.agentPreset });
        this.log('info', `[${peerKey}] created session ${session.sessionId}`);
        return session.sessionId;
      } catch (err) {
        lastErr = err;
        try {
          const { items } = await this.dsh.listSessions();
          const found = items.find((s) => s.sessionId === deterministicId);
          if (found) {
            this.state.saveSessionMapEntry(peerKey, found.sessionId, { cwd: found.cwd ?? this.dshCfg.cwd, agentPreset: found.agentPreset });
            this.log('warn', `[${peerKey}] adopted existing session ${found.sessionId} (create rejected: ${err.message})`);
            return found.sessionId;
          }
        } catch {
          // fall through to retry / rethrow
        }
        const transportish = err?.name === 'DshApiError' && (err.code === 'transport' || /HTTP\s*4\d\d/.test(err.message ?? ''));
        if (!transportish || attempt === 3) throw lastErr;
        this.log('warn', `[${peerKey}] session.create transport error, retry ${attempt}/3: ${err.message}`);
        await sleep(1000 * attempt, this.abort.signal);
      }
    }
    throw lastErr;
  }

  #createWatcher(sessionId) {
    const entry = { texts: [], done: false, timer: null };
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const finish = (reason) => {
      if (entry.done) return;
      entry.done = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.watchers.delete(sessionId);
      const text = entry.texts.filter(Boolean).pop() ?? '';
      if (reason === 'timeout') {
        resolvePromise(text || '（DSH 处理超时，请稍后重试）');
      } else if (reason === 'cancel') {
        resolvePromise('（DSH 调用被取消）');
      } else if (reason === 'unsupported-interaction') {
        resolvePromise('当前会话需要交互式提问，微信通道暂不支持。请直接发送完整问题或指令。');
      } else {
        resolvePromise(text || '（DSH 没有返回内容）');
      }
    };
    entry.timer = setTimeout(() => finish('timeout'), this.brCfg.replyTimeoutMs);
    this.watchers.set(sessionId, { ...entry, finalize: (r) => finish(r) });
    return { promise, cancel: () => finish('cancel') };
  }

  async #safeSend(toUserId, text, contextToken) {
    if (!text) return;
    try {
      await this.weixin.sendText(toUserId, text, contextToken);
    } catch (err) {
      this.log('error', `sendmessage failed to=${toUserId}: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------------
  // QR login (account (re)binding)
  // ------------------------------------------------------------------

  /**
   * Start a login session: fetch a fresh QR code.
   * @returns {{ok: boolean, qrcodeUrl?: string, expiresAt?: number, message: string}}
   */
  async startLogin(force = false) {
    const l = this.login;
    if (!force && l.active && l.qrcodeUrl && Date.now() - l.startedAt < 5 * 60_000) {
      return { ok: true, qrcodeUrl: l.qrcodeUrl, expiresAt: l.startedAt + 5 * 60_000, message: '二维码已显示，请用手机微信扫描。' };
    }
    try {
      const resp = await createWeixinClient({ baseUrl: this.wxCfg.baseUrl }).getBotQrcode(localTokenList());
      if (!resp?.qrcode || !resp?.qrcode_img_content) {
        throw new Error(`server returned no QR data: ${JSON.stringify(resp).slice(0, 200)}`);
      }
      l.active = true;
      l.qrcode = resp.qrcode;
      l.qrcodeUrl = resp.qrcode_img_content;
      l.currentApiBaseUrl = this.wxCfg.baseUrl ?? 'https://ilinkai.weixin.qq.com';
      l.startedAt = Date.now();
      l.status = 'wait';
      l.pendingVerifyCode = null;
      l.refreshCount = 0;
      l.error = null;
      this.log('info', 'QR login started');
      return { ok: true, qrcodeUrl: l.qrcodeUrl, expiresAt: l.startedAt + 5 * 60_000, message: '请用手机微信扫描二维码。' };
    } catch (err) {
      l.error = String(err);
      this.log('error', `startLogin failed: ${String(err)}`);
      return { ok: false, message: `发起登录失败: ${String(err)}` };
    }
  }

  /**
   * Long-poll the QR status. On confirm, persists the new account and
   * hot-swaps the bridge onto it.
   * @param {string} [verifyCode] user-typed pairing code (need_verifycode flow)
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{ok: boolean, status: string, message?: string, accountId?: string, userId?: string}>}
   */
  async pollLogin(verifyCode, options = {}) {
    const l = this.login;
    if (!l.active || !l.qrcode) {
      return { ok: false, status: 'none', message: '当前没有进行中的登录，请先发起登录。' };
    }
    if (verifyCode) l.pendingVerifyCode = verifyCode;

    const client = createWeixinClient({ baseUrl: l.currentApiBaseUrl });
    const resp = await client.getQrcodeStatus(l.qrcode, l.pendingVerifyCode, { timeoutMs: options.timeoutMs });
    const status = resp.status ?? 'wait';
    l.status = status;

    switch (status) {
      case 'wait':
        return { ok: true, status: 'wait' };
      case 'scaned':
        l.pendingVerifyCode = undefined;
        return { ok: true, status: 'scaned' };
      case 'need_verifycode':
        return { ok: true, status: 'need_verifycode' };
      case 'verify_code_blocked':
        l.pendingVerifyCode = undefined;
        return { ok: true, status: 'verify_code_blocked' };
      case 'scaned_but_redirect':
        if (resp.redirect_host) l.currentApiBaseUrl = `https://${resp.redirect_host}`;
        return { ok: true, status: 'scaned_but_redirect' };
      case 'binded_redirect':
        l.active = false;
        return { ok: true, status: 'already-connected', message: '该微信已绑定过本机，沿用现有凭据。' };
      case 'expired': {
        l.refreshCount += 1;
        if (l.refreshCount > MAX_QR_REFRESH) {
          l.active = false;
          return { ok: false, status: 'expired', message: '二维码多次失效，请重新发起登录。' };
        }
        const refreshed = await this.#refreshQrCode();
        if (!refreshed.ok) {
          l.active = false;
          return { ok: false, status: 'expired', message: refreshed.message };
        }
        return { ok: true, status: 'expired', message: '二维码已刷新，请重新扫描。' };
      }
      case 'confirmed': {
        if (!resp.ilink_bot_id) {
          l.active = false;
          return { ok: false, status: 'confirmed', message: '登录失败：服务器未返回 ilink_bot_id。' };
        }
        l.active = false;
        const account = {
          accountId: resp.ilink_bot_id,
          token: resp.bot_token,
          baseUrl: resp.baseurl,
          userId: resp.ilink_user_id,
        };
        try {
          saveAccount(account);
          clearStaleAccountsForUserId(account.accountId, account.userId);
          this.#adoptAccount(account);
          this.paused = false;
          this.phase = 'running';
          this.lastError = null;
          // The long-poll loop may not have been started at boot (no account
          // then) — start it now that we have a bound account. Idempotent.
          await this.#ensurePolling();
          this.log('info', `✅ login confirmed: account=${account.accountId} userId=${account.userId}`);
        } catch (err) {
          this.log('error', `failed to persist new account: ${String(err)}`);
          return { ok: false, status: 'confirmed', message: `保存账号失败: ${String(err)}` };
        }
        return {
          ok: true,
          status: 'confirmed',
          accountId: account.accountId,
          userId: account.userId,
          message: '绑定成功，通道已切换至新账号。',
        };
      }
      default:
        return { ok: true, status };
    }
  }

  async #refreshQrCode() {
    try {
      const client = createWeixinClient({ baseUrl: this.wxCfg.baseUrl });
      const resp = await client.getBotQrcode(localTokenList());
      if (!resp?.qrcode || !resp?.qrcode_img_content) throw new Error('server returned no QR data');
      this.login.qrcode = resp.qrcode;
      this.login.qrcodeUrl = resp.qrcode_img_content;
      this.login.startedAt = Date.now();
      this.login.currentApiBaseUrl = this.wxCfg.baseUrl ?? 'https://ilinkai.weixin.qq.com';
      this.login.pendingVerifyCode = undefined;
      return { ok: true };
    } catch (err) {
      return { ok: false, message: `刷新二维码失败: ${String(err)}` };
    }
  }

  cancelLogin() {
    this.login.active = false;
    this.login.qrcode = null;
    this.login.qrcodeUrl = null;
    this.log('info', 'QR login cancelled');
    return { ok: true };
  }

  /**
   * Unbind the current account: remove its credentials from the ClawBot store
   * and pause the bridge until a new QR login binds another account.
   */
  async unbind() {
    if (!this.acct?.accountId || this.acct.accountId === 'configured') {
      return { ok: false, message: '当前使用的是显式配置的 token，无法解绑（请直接删除配置）.' };
    }
    try {
      clearAccount(this.acct.accountId);
    } catch (err) {
      return { ok: false, message: `解绑失败: ${String(err)}` };
    }
    this.paused = true;
    this.phase = 'needs-login';
    this.lastError = 'account unbound';
    this.log('warn', `account ${this.acct.accountId} unbound — run QR login to bind a new one`);
    this.acct = null;
    this.weixin = null;
    return { ok: true, message: '已解绑。请重新扫码绑定账号。' };
  }

  /** Manually resume polling after a login/unbind cycle (used after the ClawBot panel binds). */
  async resume() {
    if (!this.weixin) {
      const acct = this.resolveAccount();
      if (acct?.token) {
        this.#adoptAccount(acct);
        this.phase = 'running';
        this.paused = false;
        await this.#ensurePolling();
        return { ok: true, message: `已恢复通道（account=${acct.accountId}）` };
      }
      return { ok: false, message: '尚未绑定账号，请先扫码登录。' };
    }
    this.paused = false;
    this.phase = 'running';
    await this.#ensurePolling();
    return { ok: true, message: '通道已恢复。' };
  }

  /** Status view for the web UI. */
  getStatus() {
    const l = this.login;
    return {
      phase: this.phase,
      paused: this.paused,
      account: this.acct
        ? { accountId: this.acct.accountId, userId: this.acct.userId ?? null, baseUrl: this.acct.baseUrl ?? null }
        : null,
      dsh: { baseUrl: this.dshCfg.baseUrl, cwd: this.dshCfg.cwd },
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      login: {
        active: l.active,
        status: l.status,
        qrcodeUrl: l.qrcodeUrl ?? null,
        expiresAt: l.active ? l.startedAt + 5 * 60_000 : null,
        refreshCount: l.refreshCount,
        error: l.error,
      },
      logs: this.logs.slice(-LOG_CAP),
    };
  }
}

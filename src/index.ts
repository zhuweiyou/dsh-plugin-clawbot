/**
 * dsh-plugin-clawbot — Cordis host plugin entry.
 *
 * Composes into a DSH web profile:
 *   - runs the WeChat ClawBot ⇄ DSH bridge inside the host process
 *   - registers the /clawbot JSON API (data source for the ClawBot panel in
 *     the DSH settings UI) on the DSH webserver, including the QR-code
 *     (re)login / account binding flow
 *
 * Profile wiring (cordis.patch.yml):
 *   - insert:
 *       - id: clawbot
 *         name: 'dsh-plugin-clawbot'
 *         config: { dsh: { cwd: 'D:\\workspace' } }
 */
import { ClawbotManager } from './manager.js';
import { loadConfig } from './config.js';
import { createDshClient, createInProcessDshClient } from './dsh.js';
import { renderPage } from './ui.js';
import { installClawbotSettings } from './settings.js';

export const name = 'clawbot';
export const inject = ['webServer'];

/** Merge the loader-provided row config over env/file defaults + discovery. */
function normalizeConfig(pluginCfg = {}) {
  const base = loadConfig();
  const p = pluginCfg ?? {};
  return {
    dsh: {
      baseUrl: p.dsh?.baseUrl ?? base.dsh.baseUrl,
      cwd: p.dsh?.cwd ?? base.dsh.cwd,
      agentPreset: p.dsh?.agentPreset ?? base.dsh.agentPreset,
    },
    weixin: {
      baseUrl: p.weixin?.baseUrl ?? base.weixin.baseUrl,
      token: p.weixin?.token ?? base.weixin.token,
      accountId: p.weixin?.accountId ?? base.weixin.accountId,
      allowFrom: p.weixin?.allowFrom ?? base.weixin.allowFrom,
      botAgent: p.weixin?.botAgent ?? base.weixin.botAgent,
    },
    bridge: {
      stateDir: p.bridge?.stateDir ?? base.bridge.stateDir,
      typing: p.bridge?.typing ?? base.bridge.typing,
      replyTimeoutMs: p.bridge?.replyTimeoutMs ?? base.bridge.replyTimeoutMs,
      pollTimeoutMs: p.bridge?.pollTimeoutMs ?? base.bridge.pollTimeoutMs,
      logLevel: p.bridge?.logLevel ?? base.bridge.logLevel,
    },
    discovered: base.discovered,
  };
}

/** Loopback-authority check, mirroring the /api trust fence for /clawbot. */
function isLoopbackHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  const host = hostHeader.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Build a manager from a raw plugin config (test seam + apply use). */
export function createManager(config, opts = {}) {
  const cfg = normalizeConfig(config);
  const log = opts.log ?? ((level, msg) => {
    if (level === 'debug') return;
    console[level === 'error' ? 'error' : 'log'](`[clawbot] ${msg}`);
  });
  return new ClawbotManager(cfg, { log, eventBus: opts.eventBus, dsh: opts.dsh, weixinFactory: opts.weixinFactory });
}

export function apply(ctx, config) {
  const dispositions = [];
  const route = (method, pattern, handler) => {
    dispositions.push(ctx.webServer.register({
      kind: 'prefix',
      path: pattern,
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        const matched = pathname === pattern || pathname.startsWith(`${pattern}/`);
        if (!matched) {
          sendJson(res, 404, { ok: false, message: 'not found' });
          return;
        }
        if (req.method !== method) {
          sendJson(res, 405, { ok: false, message: `method ${req.method} not allowed` });
          return;
        }
        if (!isLoopbackHost(req.headers.host)) {
          sendJson(res, 403, { ok: false, message: 'forbidden: loopback host required' });
          return;
        }
        await handler(req, res, pathname);
      },
    }));
  };

  let manager = null;
  const log = (level, msg) => {
    if (level === 'debug') return;
    try {
      if (typeof ctx.logger?.[level] === 'function') {
        ctx.logger[level](`[clawbot] ${msg}`);
        return;
      }
    } catch {
      // fall through to console
    }
    console[level === 'error' ? 'error' : 'log'](`[clawbot] ${msg}`);
  };

  // As a Cordis plugin running inside the DSH host we build the DSH API
  // client IN-PROCESS via the host's `apiProxy` service (the same bridge DSH's
  // own web frontend uses, called directly — no HTTP, no auth header). That
  // never touches an HTTP server, so it cannot be rejected by an outer
  // proxy's HTTP 401/403. Transport is chosen lazily on first use (by then the
  // host is fully booted and `apiProxy` is present); when the host exposes no
  // apiProxy at all we fall back to the classic HTTP client (older DSH, or
  // standalone/library use of the plugin).
  const cfg = normalizeConfig(config);
  let resolvedDsh = null;
  const resolveDsh = async () => {
    if (resolvedDsh) return resolvedDsh;
    // The host's `apiProxy` service may still be booting when the plugin
    // starts; give it a short grace window before committing to HTTP.
    let apiProxy;
    for (let attempt = 0; attempt < 6 && apiProxy === void 0; attempt += 1) {
      apiProxy = ctx.get('apiProxy');
      if (apiProxy === void 0 && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (apiProxy !== void 0) {
      resolvedDsh = createInProcessDshClient(apiProxy, { log: (l) => log('debug', `[dsh] ${l}`) });
      log('info', 'DSH API client: in-process (apiProxy)');
    } else {
      resolvedDsh = createDshClient(cfg.dsh.baseUrl, { log: (l) => log('debug', `[dsh] ${l}`) });
      log('info', 'DSH API client: HTTP fallback');
    }
    return resolvedDsh;
  };
  const dsh = {
    call: async (method, payload) => (await resolveDsh()).call(method, payload),
    createSession: async (opts) => (await resolveDsh()).createSession(opts),
    prompt: async (sessionId, text) => (await resolveDsh()).prompt(sessionId, text),
    cancel: async (sessionId) => (await resolveDsh()).cancel(sessionId),
    listSessions: async () => (await resolveDsh()).listSessions(),
    openMux: (onFrame, signal, onStatus, opts4) => (async () => {
      const client = await resolveDsh();
      return client.openMux(onFrame, signal, onStatus, opts4);
    })(),
    httpBase: 'lazy',
    wsBase: 'lazy',
  };

  manager = createManager(config, {
    log,
    dsh,
    // In-process event source: the plugin runs inside the host, so it listens
    // on the Cordis session/event bus at the ROOT context (the bus is emitted
    // from each session's emitCtx and bubbles to the root). This replaces the
    // self-connecting WebSocket downlink, which is unreliable from inside the
    // host process.
    eventBus: (handler) => {
      const root = ctx.root ?? ctx;
      const callback = (session, event) => {
        handler({ type: 'session/event', sessionId: session.id, event });
      };
      return root.on('session/event', callback);
    },
  });

  // Expose the user-editable subset on the DSH settings page. No-ops when a
  // host has no settings service (installSettingsSection rides the scoped
  // fiber and simply never runs there).
  installClawbotSettings(ctx, manager.cfg.dsh);

  route('GET', '/clawbot/api/status', async (req, res) => {
    sendJson(res, 200, manager.getStatus());
  });

  route('POST', '/clawbot/api/login/start', async (req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await manager.startLogin(Boolean(body?.force)));
  });

  route('POST', '/clawbot/api/login/poll', async (req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await manager.pollLogin(body?.verifyCode));
  });

  route('POST', '/clawbot/api/login/cancel', async (req, res) => {
    sendJson(res, 200, manager.cancelLogin());
  });

  route('POST', '/clawbot/api/unbind', async (req, res) => {
    sendJson(res, 200, await manager.unbind());
  });

  route('POST', '/clawbot/api/resume', async (req, res) => {
    sendJson(res, 200, await manager.resume());
  });

  // Start the channel; never let startup failure take down the host.
  manager.start().catch((err) => log('error', `clawbot start failed: ${String(err)}`));

  return async () => {
    for (const d of dispositions) {
      try {
        d();
      } catch {
        // ignore
      }
    }
    if (manager) await manager.stop();
  };
}

export default { name, inject, apply, createManager };

import crypto from "node:crypto";
class DshApiError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "DshApiError";
    this.code = code;
    this.details = details;
  }
}
function splitBases(baseUrl) {
  const u = new URL(baseUrl);
  const wsScheme = u.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpBase: u.origin,
    wsBase: `${wsScheme}//${u.host}`
  };
}
function wireMethod(method) {
  return String(method).includes("/") ? String(method) : String(method).replace(".", "/");
}
function wirePayload(method, payload) {
  return wireMethod(method) === "session/list" ? { args: { _request: {} } } : { args: { request: payload } };
}
/**
 * Build a DSH API client that talks to the host **in-process** — the same
 * bridge DSH's own web frontend uses — instead of hand-rolled HTTP to
 * `127.0.0.1:3080`. This is the correct transport for a Cordis plugin that
 * runs inside the DSH host: it needs no auth header nor a reachable /api
 * endpoint, so it can never be rejected by an outer proxy's HTTP 401/403.
 *
 * The host's `apiProxy` service exposes the full server-side surface directly
 * (`sessions.*`, `events.mux`), each method taking `{ rpcId, payload }` and
 * returning `{ rpcId, result: { ok, value } }`. We call it directly, so no
 * `@deepseek-ai/dsh-host-apiproxy` module import is needed at runtime (that
 * package is not resolvable from a plugin installed into a profile).
 *
 * `ClawbotManager` calls `createSession`/`prompt`/`cancel`/`listSessions`/
 * `openMux` on the injected `dsh` client; this adapter maps those onto the
 * apiProxy surface.
 * @param apiProxy - the host's `apiProxy` service (`ctx.get('apiProxy')`).
 * @param opts - optional `log` for mux diagnostics.
 */
export function createInProcessDshClient(apiProxy, opts = {}) {
  const log = opts.log ?? (() => {
  });
  const unwrap = (method, call) => async (payload, signal) => {
    const { result } = await call({ rpcId: crypto.randomUUID(), payload }, signal);
    if (!result.ok) {
      const err = result.error ?? {};
      throw new DshApiError(`${method} failed: ${err.message ?? JSON.stringify(err)}`, err.code, err.details);
    }
    return result.value;
  };
  const sessions = apiProxy.sessions;
  return {
    // Generic unary: "session.create" -> apiProxy.sessions.create. The host's
    // apiProxy exposes plural groups (sessions/subagents/goals/agentPresets/
    // skills); tolerate both spellings so dotted method names resolve.
    call: (method, payload = {}) => unwrap(method, (req, s) => {
      const [group, name] = String(method).split('.');
      const fn = apiProxy[group]?.[name] ?? apiProxy[`${group}s`]?.[name];
      if (typeof fn !== 'function') {
        throw new DshApiError(`unknown method ${method}`, 'bad-request');
      }
      return fn(req, s);
    })(payload),
    createSession: async ({ cwd, sessionId, agentPreset } = {}) => unwrap('session.create', sessions.create)({
      ...cwd ? { cwd } : {},
      ...sessionId !== void 0 ? { sessionId } : {},
      ...agentPreset !== void 0 ? { agentPreset } : {},
    }),
    prompt: (sessionId, text) => unwrap('session.prompt', sessions.prompt)({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }),
    cancel: (sessionId) => unwrap('session.cancel', sessions.cancel)({ sessionId }),
    listSessions: () => unwrap('session.list', sessions.list)({}),
    openMux: (onFrame, signal, onStatus) => {
      // apiProxy.events.mux returns an async generator (FrameQueue.iterate)
      // that already stops itself when `signal` aborts and then runs its
      // internal cleanup; the abort listener lives inside queue.iterate, so we
      // must NOT add our own (it would double-run the disposers).
      const frames = apiProxy.events.mux({ rpcId: crypto.randomUUID(), payload: {} }, signal);
      onStatus?.('connected', 'in-process apiProxy');
      const pump = (async () => {
        for await (const { payload } of frames) onFrame(payload);
      })();
      return pump;
    },
    httpBase: 'in-process',
    wsBase: 'in-process',
  };
}

function createDshClient(baseUrl, opts = {}) {
  const { httpBase, wsBase } = splitBases(baseUrl ?? "http://127.0.0.1:3080");
  const log = opts.log ?? (() => {
  });
  const timeoutMs = opts.timeoutMs ?? 3e4;
  async function call(method, payload = {}) {
    const endpoint = wireMethod(method);
    const rpcId = crypto.randomUUID();
    const res = await fetch(`${httpBase}/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: wirePayload(endpoint, payload) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new DshApiError(`transport failure for ${method}: HTTP ${res.status}`, "transport");
    let full;
    try {
      full = await res.json();
    } catch {
      throw new DshApiError(`non-JSON response for ${method}`, "transport");
    }
    if (full.rpcId !== rpcId) throw new DshApiError(`rpcId mismatch for ${method}`, "protocol");
    if (!full.result?.ok) {
      const err = full.result?.error ?? {};
      throw new DshApiError(`${method} failed: ${err.message ?? JSON.stringify(err)}`, err.code, err.details);
    }
    return full.result.value;
  }
  async function createSession({ cwd, sessionId, agentPreset } = {}) {
    return call("session.create", {
      ...cwd ? { cwd } : {},
      ...sessionId !== void 0 ? { sessionId } : {},
      ...agentPreset !== void 0 ? { agentPreset } : {}
    });
  }
  async function prompt(sessionId, text) {
    return call("session.prompt", {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }]
    });
  }
  async function cancel(sessionId) {
    return call("session.cancel", { sessionId });
  }
  async function listSessions() {
    return call("session.list", {});
  }
  async function openMux(onFrame, signal, onStatus, opts2 = {}) {
    if (opts2.eventBus) {
      const disposer = opts2.eventBus((payload) => onFrame(payload));
      signal?.addEventListener("abort", () => {
        try {
          disposer?.();
        } catch {
        }
      }, { once: true });
      onStatus?.("connected", "in-process event bus");
      return;
    }
    let attempt = 0;
    while (!signal?.aborted) {
      attempt += 1;
      const ws = new WebSocket(`${wsBase}/api/events.mux`);
      const settleTimer = setTimeout(() => {
        log(`mux handshake unsettled after 15s (attempt ${attempt}, readyState=${ws.readyState})`);
      }, 15e3);
      await new Promise((resolve) => {
        const settle = () => {
          clearTimeout(settleTimer);
          resolve();
        };
        ws.addEventListener("open", () => {
          onStatus?.("connected", `attempt ${attempt}`);
          settle();
        }, { once: true });
        ws.addEventListener("error", () => settle(), { once: true });
        ws.addEventListener("close", () => settle(), { once: true });
      });
      if (signal?.aborted) {
        ws.close();
        break;
      }
      let closeReason = null;
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        onFrame(msg.payload ?? {});
      });
      ws.addEventListener("close", (ev) => {
        closeReason = ev.code;
      });
      const closed = new Promise((resolveClose) => {
        ws.addEventListener("close", () => resolveClose(), { once: true });
        ws.addEventListener("error", () => resolveClose(), { once: true });
      });
      await Promise.race([closed, abortPromise(signal)]);
      if (closeReason !== null) log(`mux closed (code=${closeReason})`);
      ws.close();
      if (signal?.aborted) break;
      onStatus?.("reconnecting", `attempt ${attempt}`);
      await sleep(Math.min(1e3 * 2 ** Math.min(attempt - 1, 5), 3e4), signal);
    }
  }
  return { call, createSession, prompt, cancel, listSessions, openMux, httpBase, wsBase };
}
function abortPromise(signal) {
  return new Promise((resolve) => {
    if (!signal) return resolve();
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
export {
  DshApiError,
  createDshClient
};

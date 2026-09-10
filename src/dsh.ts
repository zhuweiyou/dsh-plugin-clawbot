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

/**
 * Build a DSH API client over the host's `agents` Cordis service — the
 * same surface dsh-memory-evolve / the official api-proxy path use
 * (`agents.create` == api-proxy `session.create`, `agent.followup` ==
 * `session.prompt`).  This is the correct transport for a Cordis plugin
 * running inside the DSH host on current builds: it needs no HTTP call,
 * no auth cookie and no `/api` route, so it can never hit a 401.
 *
 * The host `agents` service (see `@deepseek-ai/dsh-agent`) exposes:
 *   - `agents.get(id)`      → live Agent | undefined
 *   - `agents.create(opts)` → { agent, ... }  (idempotent create/adopt)
 *   - `agents.resume(opts)` → { agent, ... }  (restore offline session)
 *   - `agents.list()`       → live Agent[]
 * and each Agent has `followup(message)` / `cancel(cause, opts)`.
 *
 * We map the `ClawbotManager`'s dsh surface (`createSession`/`prompt`/
 * `cancel`/`listSessions`/`openMux`) onto that service, mirroring the
 * resolution order dsh-memory-evolve uses for wake: look up the live
 * agent, else resume from persistence, else create.
 *
 * @param agents - the host `agents` service (`ctx.get('agents')`).
 * @param opts - optional `log` plus an `agentPresets` lookup (dynamic
 *   `ctx.get('agentPresets')`) used to mount the session's agent preset.
 */
export function createAgentsDshClient(agents, opts = {}) {
  const log = opts.log ?? (() => {
  });
  const resolvePreset = opts.agentPresets;
  const defaultModel = opts.defaultModel;           // ctx.get('agentDefaultModel')
  const sessionController = opts.sessionController; // ctx.get('sessionController') — optional
  /** DSH user message shape (same as dsh-memory-evolve's userMessage). */
  const userMessage = (text) => ({
    role: 'user',
    id: crypto.randomUUID(),
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  });
  /** Setup callback that mounts the given agent preset, when available. */
  const presetSetupFor = async (agentPreset) => {
    if (!resolvePreset) return undefined;
    try {
      if (typeof resolvePreset.resolve !== 'function' || typeof resolvePreset.mount !== 'function') return undefined;
      const resolved = await resolvePreset.resolve(agentPreset ?? undefined);
      const presetId = String(resolved?.id ?? '').trim();
      if (presetId === '') return undefined;
      return {
        id: presetId,
        setup: async (agentCtx) => {
          await resolvePreset.mount(agentCtx, presetId);
        },
      };
    } catch (error) {
      log(`agentPresets setup skipped: ${String(error)}`);
      return undefined;
    }
  };
  /** The deployment default model selection, when the service exists. */
  const defaultAgentOptions = () => {
    try {
      const sel = defaultModel?.currentSelection?.();
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
    } catch (error) {
      log(`agentDefaultModel selection failed: ${String(error)}`);
    }
    return undefined;
  };
  /**
   * The model config this session itself last used (from its durable log's
   * request/header), so a resumed offline session keeps its own provider/
   * model — without it the restored agent.options is empty and turn
   * assembly fails with "prompt variable {{model}} has no value".
   */
  const persistedAgentOptions = async (sessionId) => {
    if (!sessionController) return undefined;
    try {
      const insp = await sessionController.inspect(sessionId);
      const headers = insp?.events?.filter((e) => e?.type === 'request/header') ?? [];
      const cfg = headers[headers.length - 1]?.data?.header?.config;
      if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model };
    } catch (error) {
      log(`sessionController.inspect failed for ${sessionId}: ${String(error)}`);
    }
    return undefined;
  };
  /** Ensure a live Agent for a session id: live → resume → create. */
  const ensureAgent = async ({ sessionId, cwd, agentPreset }) => {
    let agent = agents.get(sessionId);
    if (agent !== undefined) return agent;
    try {
      // Resume must carry the session's own model config (see persistedAgentOptions)
      // or the deployment default, otherwise {{model}}/{{provider}} have no value.
      const agentOptions = (await persistedAgentOptions(sessionId)) ?? defaultAgentOptions();
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions ? { agentOptions } : {}),
      });
      if (handle?.agent) return handle.agent;
    } catch (error) {
      log(`agents.resume failed (will create): ${String(error)}`);
    }
    const setup = await presetSetupFor(agentPreset);
    const agentOptions = defaultAgentOptions();
    const handle = await agents.create({
      sessionId,
      ...(agentOptions ? { agentOptions } : {}),
      ...(cwd || agentPreset || setup
        ? { meta: { ...(cwd ? { cwd } : {}), ...(setup ? { agentPreset: setup.id } : agentPreset ? { agentPreset } : {}) } }
        : {}),
      ...(setup ? { setup: setup.setup } : {}),
    });
    if (!handle?.agent) throw new DshApiError(`agents.create returned no agent for ${sessionId}`, 'gateway/internal');
    return handle.agent;
  };
  return {
    call: async (method, payload = {}) => {
      const [group, name] = String(method).split('.');
      const fn = agents[group]?.[name] ?? agents[`${group}s`]?.[name];
      if (typeof fn !== 'function') throw new DshApiError(`unknown method ${method}`, 'bad-request');
      return fn(payload);
    },
    createSession: async ({ cwd, sessionId, agentPreset } = {}) => {
      const agent = await ensureAgent({ sessionId, cwd, agentPreset });
      return { sessionId: agent.id, ...(agentPreset ? { agentPreset } : {}) };
    },
    prompt: async (sessionId, text) => {
      const agent = await ensureAgent({ sessionId });
      agent.followup(userMessage(text));
      return { accepted: true, sessionId };
    },
    cancel: async (sessionId) => {
      const agent = agents.get(sessionId);
      if (agent !== undefined) agent.cancel({ kind: 'user' }, { keepInbox: true });
      return { accepted: true, sessionId };
    },
    listSessions: async () => {
      const items = agents.list().map((agent) => ({
        sessionId: agent.id,
        cwd: agent.session?.header?.cwd,
        agentPreset: undefined,
      }));
      return { items };
    },
    openMux: (onFrame, signal, onStatus, opts2 = {}) => {
      if (opts2.eventBus) {
        const disposer = opts2.eventBus((payload) => onFrame(payload));
        signal?.addEventListener('abort', () => {
          try {
            disposer?.();
          } catch {
          }
        }, { once: true });
        onStatus?.('connected', 'in-process event bus');
        return;
      }
      // Without an event bus we have no downlink; the host plugin always
      // provides one (see index.ts), so this is a programming error.
      throw new DshApiError('agents client requires an in-process event bus', 'bad-request');
    },
    httpBase: 'in-process',
    wsBase: 'in-process',
  };
}

/**
 * Build a DSH API client over the host's `sessionController` Cordis service —
 * the **same full path the DSH web UI itself uses** (`session.create` ==
 * GUI "new session", `session.prompt` == GUI send). This is the strongest
 * in-process option on current builds:
 *
 *   - creation is *complete*: it goes through composeAgent (preset resolve +
 *     mount, model selection, workspace attach) and registers the session in
 *     the durable `sessionQuery` — an ordinary `agents.create` that skips the
 *     controller does none of that, so the session never persists and the UI
 *     history page fails with `session/not-found` while WeChat gets an empty
 *     reply (see dsh-memory-evolve's notes on the same pitfall).
 *   - it is the host-side owner of the same Remote namespace the browser
 *     talks to over `/api/session.*`, so history, the session list, and the
 *     model picker all see our sessions.
 *
 * `ClawbotManager` calls `createSession`/`prompt`/`cancel`/`listSessions`/
 * `openMux` on the injected `dsh` client; we map those onto the controller's
 * methods directly (`create`/`prompt`/`cancel`/`list`), same shapes as the
 * HTTP client would produce (returns are plain values, not RPC envelopes).
 *
 * @param sessionController - the host `sessionController` service
 *   (`ctx.get('sessionController')`), a `TypertRemoteService` subclass whose
 *   Remote decorators only tag methods for the gateway — calling the instance
 *   methods directly runs the real host implementation.
 * @param opts - optional `log` for diagnostics.
 */
export function createSessionControllerDshClient(sessionController, opts = {}) {
  const log = opts.log ?? (() => {
  });
  // Some controller methods (prompt/list/page/...) take a caller `signal`
  // argument and call `signal.throwIfAborted()` unconditionally (not
  // optional-chained), so in-process callers must supply one. Keep a
  // never-aborting signal so host calls behave like the browser client's
  // long-lived Remote stream.
  const neverAbort = new AbortController().signal;
  /** RemoteError → DshApiError so manager transport-detection keeps working. */
  const wrapError = (method, error) => {
    if (error instanceof DshApiError) return error;
    const remote = error?.isDSHRemoteError === true ? error : undefined;
    // RemoteError keeps its true cause in `details.reason` (for example the
    // inner error string behind session/agent-busy "prompt rejected"); surface
    // it in the message so host logs show the reason, not just the label.
    const reason = remote?.details?.reason ?? remote?.details?.message;
    const detail = typeof reason === 'string' && reason !== '' ? ` (${reason})` : '';
    return new DshApiError(
      `${method} failed: ${remote?.message ?? error?.message ?? String(error)}${detail}`,
      remote?.code ?? error?.code ?? 'gateway/internal',
      remote?.details ?? error?.details,
    );
  };
  const withError = (method, fn) => async (payload = {}, signal) => {
    try {
      return await fn(payload, signal);
    } catch (error) {
      throw wrapError(method, error);
    }
  };
  return {
    // Generic unary dispatch: "session.create" → sessionController.create.
    // The controller carries the exact method names the wire namespace uses.
    call: (method, payload = {}) => {
      const name = String(method).replace(/^session\./, '').replace(/^sessions\./, '');
      const fn = sessionController[name];
      if (typeof fn !== 'function') throw new DshApiError(`unknown method ${method}`, 'bad-request');
      return withError(method, (p, s) => fn.call(sessionController, p, s))(payload, neverAbort);
    },
    // sessionController.create({ sessionId, cwd, agentPreset }) → { sessionId, agentPreset? }.
    createSession: async ({ cwd, sessionId, agentPreset } = {}) => withError('session.create', (p) => sessionController.create(p))({
      ...cwd ? { cwd } : {},
      ...sessionId !== void 0 ? { sessionId } : {},
      ...agentPreset !== void 0 ? { agentPreset } : {},
    }),
    // sessionController.prompt({ sessionId, requestId, mode, content }, signal)
    // → { accepted }. `requestId` is REQUIRED (it lands in the accepted
    // message's `source.rpcId`); omitting it makes `source.rpcId` undefined,
    // which is refused at inbox admission and resurfaces as a generic
    // session/agent-busy "prompt rejected".
    prompt: (sessionId, text) => withError('session.prompt', (p, s) => sessionController.prompt(p, s))({
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, neverAbort),
    // sessionController.cancel({ sessionId }) → { accepted }.
    cancel: (sessionId) => withError('session.cancel', (p) => sessionController.cancel(p))({ sessionId }),
    // sessionController.list({}, signal) → { items } — shapes already match
    // the HTTP surface ({ sessionId, cwd, running, blank, ... }).
    listSessions: () => withError('session.list', (p, s) => sessionController.list(p, s))({}, neverAbort),
    openMux: (onFrame, signal, onStatus, opts2 = {}) => {
      if (opts2.eventBus) {
        const disposer = opts2.eventBus((payload) => onFrame(payload));
        signal?.addEventListener('abort', () => {
          try {
            disposer?.();
          } catch {
          }
        }, { once: true });
        onStatus?.('connected', 'in-process event bus');
        return;
      }
      // Without an event bus we have no downlink; the host plugin always
      // provides one (see index.ts), so this is a programming error.
      throw new DshApiError('sessionController client requires an in-process event bus', 'bad-request');
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

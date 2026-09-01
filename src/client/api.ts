/**
 * Client-side helpers for the ClawBot host API (JSON over /clawbot/api/*).
 *
 * `api()` resolves a path against the host's base URI (like the market's
 * `api()` helper), so the panel works behind reverse proxies too.
 */

/** Resolve a /clawbot/api path against the current page base URI. */
export function api(path: string): string {
  const relative = path.replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}

// ----------------------------------------------------------------
// Status types — mirrors the JSON shape returned by GET /clawbot/api/status
// ----------------------------------------------------------------

export interface ClawbotLoginInfo {
  active: boolean
  status: string | null
  qrcodeUrl: string | null
  expiresAt: number | null
  refreshCount: number
  error: string | null
}

export interface ClawbotStatus {
  phase: string
  paused: boolean
  account: { accountId: string; userId: string | null; baseUrl: string | null } | null
  dsh: { baseUrl: string; cwd: string }
  lastPollAt: number | null
  lastError: string | null
  login: ClawbotLoginInfo
  logs: { at: number; level: string; msg: string }[]
}

export interface ClawbotLoginStartResult {
  ok: boolean
  qrcodeUrl?: string
  expiresAt?: number
  message?: string
}

export interface ClawbotLoginPollResult {
  ok: boolean
  status: string
  message?: string
  accountId?: string
  userId?: string
}

export interface ClawbotGenericResult {
  ok: boolean
  message?: string
}

// ----------------------------------------------------------------
// API fetch helpers
// ----------------------------------------------------------------

export async function fetchStatus(): Promise<ClawbotStatus | null> {
  try {
    const res = await fetch(api('/clawbot/api/status'), { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as ClawbotStatus
  } catch { return null }
}

export async function startLogin(force: boolean): Promise<ClawbotLoginStartResult> {
  const res = await fetch(api('/clawbot/api/login/start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force }),
  })
  return (await res.json()) as ClawbotLoginStartResult
}

export async function pollLogin(verifyCode?: string): Promise<ClawbotLoginPollResult> {
  const res = await fetch(api('/clawbot/api/login/poll'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifyCode }),
  })
  return (await res.json()) as ClawbotLoginPollResult
}

export async function cancelLogin(): Promise<ClawbotGenericResult> {
  const res = await fetch(api('/clawbot/api/login/cancel'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return (await res.json()) as ClawbotGenericResult
}

export async function unbindAccount(): Promise<ClawbotGenericResult> {
  const res = await fetch(api('/clawbot/api/unbind'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return (await res.json()) as ClawbotGenericResult
}

export async function resumeChannel(): Promise<ClawbotGenericResult> {
  const res = await fetch(api('/clawbot/api/resume'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return (await res.json()) as ClawbotGenericResult
}
/**
 * ClawbotSection: the settings panel rendered behind the "ClawBot 微信通道"
 * section menu entry in DSH settings.
 *
 * Polls /clawbot/api/status every 4 seconds; renders status badge, QR-code
 * login flow, unbind, and log stream — all in React + CSS custom properties
 * (--dsw-*) so the panel automatically matches light/dark themes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translate } from './locales.ts'
import {
  fetchStatus,
  startLogin,
  pollLogin,
  cancelLogin,
  unbindAccount,
  type ClawbotStatus,
} from './api.ts'

// ---- CSS variable tokens (follows DSH design tokens) ----
const v = (name: string) => `var(--dsw-${name})`

// ---- inline style fragments ----
const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 14, lineHeight: '22px' },
  card: {
    background: v('alias-bg-surface'),
    border: `1px solid ${v('alias-border-l2')}`,
    borderRadius: 10,
    padding: '16px 20px',
  },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: v('alias-label-primary') },
  row: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    fontSize: 13, lineHeight: '20px', marginTop: 4,
  },
  kv: { color: v('alias-label-secondary'), minWidth: 100 },
  val: { color: v('alias-label-primary'), wordBreak: 'break-all' },
  btn: {
    background: v('alias-interactive-bg'),
    color: v('alias-label-primary'),
    border: `1px solid ${v('alias-border-l2')}`,
    borderRadius: 8,
    padding: '7px 16px',
    fontSize: 13,
    cursor: 'pointer',
    transition: 'background .15s',
  },
  btnPrimary: { background: v('alias-brand-bg'), color: v('alias-brand-text') },
  btnDanger: { background: v('alias-feedback-error-bg'), color: v('alias-feedback-error-text') },
  btnDisabled: { opacity: 0.5, pointerEvents: 'none' },
  qrImg: {
    width: 280, height: 280,
    imageRendering: 'pixelated',
    border: `1px solid ${v('alias-border-l2')}`,
    borderRadius: 8,
    background: '#fff',
  },
  logsWrap: {
    maxHeight: 280,
    overflow: 'auto',
    fontFamily: 'Consolas, Menlo, monospace',
    fontSize: 12,
    lineHeight: '18px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    padding: 10,
    border: `1px solid ${v('alias-border-l2')}`,
    borderRadius: 8,
    background: v('alias-bg-surface'),
  },
  logLine: { borderBottom: `1px solid ${v('alias-border-l2')}`, padding: '3px 0' },
  input: {
    background: v('alias-bg-surface'),
    border: `1px solid ${v('alias-border-l2')}`,
    color: v('alias-label-primary'),
    borderRadius: 8,
    padding: '7px 10px',
    fontSize: 14,
    outline: 'none',
  },
}

// ---- helpers ----

const PHASE_LABELS: Record<string, string> = {
  running: 'phaseRunning',
  'needs-login': 'phaseLogin',
  starting: 'phaseStarting',
  stopped: 'stopped',
}

function phaseBadge(phase: string) {
  // Semantic DSH tokens: a soft tertiary background with a matching primary
  // foreground. The alias-state-* tokens keep the badge readable and on-brand
  // in BOTH light and dark themes (they do not flip with the theme).
  const tokens: Record<string, { bg: string; fg: string }> = {
    running:       { bg: 'var(--dsw-alias-state-success-tertiary)', fg: 'var(--dsw-alias-state-success-primary)' },
    'needs-login': { bg: 'var(--dsw-alias-state-warn-tertiary)', fg: 'var(--dsw-alias-state-warn-label)' },
    stopped:       { bg: 'var(--dsw-alias-state-error-secondary)', fg: 'var(--dsw-alias-state-error-primary)' },
    starting:      { bg: 'var(--dsw-alias-state-business-tertiary)', fg: 'var(--dsw-alias-state-business-primary)' },
  }
  const c = tokens[phase] ?? tokens.starting
  return { background: c.bg, color: c.fg, padding: '2px 10px', borderRadius: 999, fontSize: 12, lineHeight: '18px' }
}

function fmtTs(ms: number | null) {
  return ms ? new Date(ms).toLocaleString() : '—'
}

// ---- component ----

export function ClawbotSection({ t }: { t: Translate }) {
  const [status, setStatus] = useState<ClawbotStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [loginStatus, setLoginStatus] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [showVerify, setShowVerify] = useState(false)
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const loginPollRef = useRef<number | null>(null)

  // ---- status polling ----
  const refreshStatus = useCallback(async () => {
    const s = await fetchStatus()
    if (s) { setStatus(s); setError(null) }
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])
  useEffect(() => {
    pollRef.current = window.setInterval(refreshStatus, 4000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [refreshStatus])

  // ---- login polling (while QR active) ----
  const loginPoll = useCallback(async (verify?: string) => {
    try {
      const r = await pollLogin(verify)
      if (r.status === 'need_verifycode') { setShowVerify(true); setLoginStatus('loginNeedVerifyCode'); return }
      if (r.status === 'confirmed') { setLoginStatus('loginConfirmed'); setQrUrl(null); refreshStatus(); return }
      if (r.status === 'expired') { setLoginStatus('loginExpired'); return }
      if (r.status === 'scaned') { setLoginStatus('loginScaned'); return }
      if (r.status === 'scaned_but_redirect') { setLoginStatus('loginRedirect'); return }
      if (r.status === 'already-connected') { setLoginStatus('loginAlreadyConnected'); return }
      if (r.status === 'verify_code_blocked') { setLoginStatus('loginVerifyCodeBlocked'); setVerifyCode(''); return }
      setLoginStatus('')
    } catch { setLoginStatus('loginQrFailed') }
  }, [refreshStatus])

  useEffect(() => {
    if (!qrUrl) return
    loginPollRef.current = window.setInterval(() => loginPoll(), 5000)
    return () => { if (loginPollRef.current) clearInterval(loginPollRef.current) }
  }, [qrUrl, loginPoll])

  // ---- handlers ----
  const onLogin = useCallback(async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const r = await startLogin(true)
      if (r.ok && r.qrcodeUrl) { setQrUrl(r.qrcodeUrl); setLoginStatus('loginQrHint'); }
      else { setError(r.message ?? 'loginQrFailed'); setLoginStatus('loginQrFailed') }
    } catch (e) { setError(String(e)) }
    setBusy(false)
  }, [busy])

  const onUnbind = useCallback(async () => {
    if (busy) return
    setConfirmUnbind(false); setBusy(true); setError(null)
    try {
      const r = await unbindAccount()
      if (!r.ok) setError(r.message ?? 'unbind failed')
      refreshStatus()
    } catch (e) { setError(String(e)) }
    setBusy(false)
  }, [busy, refreshStatus])

  const onVerify = useCallback(async () => {
    if (!verifyCode.trim()) return
    setShowVerify(false)
    loginPoll(verifyCode.trim())
    setVerifyCode('')
  }, [verifyCode, loginPoll])

  const onCancel = useCallback(async () => {
    await cancelLogin()
    setQrUrl(null); setLoginStatus('loginCancelled')
  }, [])

  const loginActive = status?.login.active && qrUrl !== null
  const phaseKey = PHASE_LABELS[status?.phase ?? ''] ?? status?.phase ?? '—'

  return (
    <div style={styles.page}>
      {/* ---- status card ---- */}
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>{t('status')}</h3>
        <div style={styles.row}>
          <span style={styles.kv}>{t('status')}</span>
          <span style={phaseBadge(status?.phase ?? 'starting')}>{t(phaseKey)}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.kv}>{t('accountLabel')}</span>
          <span style={styles.val}>{status?.account?.accountId ?? '—'}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.kv}>{t('userIdLabel')}</span>
          <span style={styles.val}>{status?.account?.userId ?? '—'}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.kv}>{t('dshLabel')}</span>
          <span style={styles.val}>{status?.dsh.baseUrl ?? '—'}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.kv}>{t('lastPoll')}</span>
          <span style={styles.val}>{fmtTs(status?.lastPollAt ?? null)}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.kv}>{t('lastError')}</span>
          <span style={{ ...styles.val, color: status?.lastError ? v('alias-feedback-error-text') : undefined }}>
            {status?.lastError ?? '—'}
          </span>
        </div>
        {/* buttons */}
        <div style={{ ...styles.row, marginTop: 12 }}>
          <button style={{ ...styles.btn, ...(busy ? styles.btnDisabled : styles.btnPrimary) }} onClick={onLogin}>
            {t('loginBtn')}
          </button>
          <button
            style={{ ...styles.btn, ...(busy ? styles.btnDisabled : styles.btnDanger) }}
            onClick={() => confirmUnbind ? onUnbind() : setConfirmUnbind(true)}
          >
            {confirmUnbind ? '确认解绑' : t('unbindBtn')}
          </button>
        </div>
        {confirmUnbind && (
          <div style={{ ...styles.row, marginTop: 4, color: v('alias-feedback-warning-text') }}>
            {t('unbindConfirm')}
          </div>
        )}
      </div>

      {/* ---- QR login card ---- */}
      {loginActive && (
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>{t('loginCardTitle')}</h3>
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrUrl!)}`}
            style={styles.qrImg}
            alt="QR"
          />
          {loginStatus && (
            <div style={{ ...styles.row, marginTop: 8, color: v('alias-label-primary') }}>
              {t(loginStatus)}
            </div>
          )}
          {showVerify && (
            <div style={{ ...styles.row, marginTop: 8 }}>
              <input
                type="text"
                style={styles.input}
                placeholder={t('loginVerifyCodePlaceholder')}
                value={verifyCode}
                onInput={(e) => setVerifyCode((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onVerify() }}
              />
              <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={onVerify}>
                {t('loginVerifyCodeBtn')}
              </button>
            </div>
          )}
          <div style={{ ...styles.row, marginTop: 8 }}>
            <button style={styles.btn} onClick={onCancel}>
              {t('loginCardBtn')}
            </button>
          </div>
        </div>
      )}

      {/* ---- logs card ---- */}
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>{t('logsTitle')}</h3>
        <div style={styles.logsWrap}>
          {(status?.logs?.length ?? 0) === 0 ? (
            <div style={{ ...styles.logLine, borderBottom: 'none', color: v('alias-label-secondary') }}>
              {t('logsEmpty')}
            </div>
          ) : (
            status!.logs.slice(-100).map((l, i) => (
              <div
                key={i}
                style={{
                  ...styles.logLine,
                  color: l.level === 'error' ? v('alias-feedback-error-text') : v('alias-label-secondary'),
                }}
              >
                {`${fmtTs(l.at)}  [${l.level}] ${l.msg}`}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ---- error toast ---- */}
      {error && (
        <div style={{ ...styles.card, background: v('alias-feedback-error-bg'), color: v('alias-feedback-error-text'), fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  )
}
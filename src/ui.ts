function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawBot \u901A\u9053</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: #101318; color: #e6e8ec; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b919c; font-size: 13px; margin-bottom: 20px; }
  .card { background: #181c22; border: 1px solid #262b34; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: #b9c0ca; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; font-size: 13px; }
  .kv { color: #8b919c; min-width: 84px; }
  .val { color: #e6e8ec; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .badge.running { background: #12341f; color: #4ade80; }
  .badge.needs-login { background: #3a2510; color: #fbbf24; }
  .badge.stopped { background: #2a1215; color: #f87171; }
  .badge.starting { background: #1c2740; color: #60a5fa; }
  button { background: #2b3340; color: #e6e8ec; border: 1px solid #3a4454; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
  button:hover { background: #354052; }
  button.primary { background: #1d5c3a; border-color: #2c8a57; }
  button.primary:hover { background: #23704a; }
  button.danger { background: #4a1d1d; border-color: #8a2c2c; }
  button.danger:hover { background: #5c2424; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #qr img { width: 280px; height: 280px; image-rendering: pixelated; border: 1px solid #333; border-radius: 8px; background: #fff; }
  #qr a { display: block; color: #60a5fa; font-size: 12px; word-break: break-all; margin-top: 8px; }
  #loginStatus { font-size: 14px; margin-top: 12px; min-height: 20px; }
  input[type=text] { background: #101318; border: 1px solid #3a4454; color: #e6e8ec; border-radius: 8px; padding: 8px 12px; font-size: 14px; }
  #verifyBox { display: none; gap: 8px; align-items: center; margin-top: 12px; }
  #logs { background: #101318; border: 1px solid #262b34; border-radius: 8px; padding: 10px; font-family: Consolas, monospace; font-size: 12px; max-height: 260px; overflow-y: auto; }
  #logs div { padding: 2px 0; border-bottom: 1px solid #1a1f26; }
  .t-error { color: #f87171; } .t-warn { color: #fbbf24; } .t-info { color: #9fb0c4; }
  .err { color: #f87171; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ClawBot \u5FAE\u4FE1\u901A\u9053</h1>
  <div class="sub">DSH \u21C4 \u5FAE\u4FE1 ClawBot \u53CC\u5411\u6865\u63A5 \xB7 \u8D26\u53F7\u7ED1\u5B9A / \u91CD\u65B0\u626B\u7801\u767B\u5F55</div>

  <div class="card">
    <h2>\u901A\u9053\u72B6\u6001</h2>
    <div class="row"><span class="kv">\u72B6\u6001</span><span id="phase" class="badge">\u2026</span></div>
    <div class="row"><span class="kv">\u8D26\u53F7</span><span id="accountId" class="val">-</span></div>
    <div class="row"><span class="kv">\u5FAE\u4FE1\u7528\u6237</span><span id="userId" class="val">-</span></div>
    <div class="row"><span class="kv">DSH</span><span id="dshBase" class="val">-</span></div>
    <div class="row"><span class="kv">\u6700\u8FD1\u8F6E\u8BE2</span><span id="lastPoll" class="val">-</span></div>
    <div class="row"><span class="kv">\u6700\u8FD1\u9519\u8BEF</span><span id="lastError" class="err">-</span></div>
    <div class="row" style="margin-top:12px">
      <button id="btnLogin" class="primary">\u626B\u7801\u7ED1\u5B9A / \u91CD\u65B0\u767B\u5F55</button>
      <button id="btnUnbind" class="danger">\u89E3\u7ED1\u8D26\u53F7</button>
    </div>
  </div>

  <div class="card" id="loginCard" style="display:none">
    <h2>\u626B\u7801\u767B\u5F55</h2>
    <div id="qr"></div>
    <div id="loginStatus"></div>
    <div id="verifyBox">
      <input type="text" id="verifyInput" placeholder="\u8F93\u5165\u624B\u673A\u5FAE\u4FE1\u663E\u793A\u7684\u6570\u5B57" autocomplete="off">
      <button id="btnVerify">\u63D0\u4EA4</button>
    </div>
    <div class="row" style="margin-top:12px">
      <button id="btnCancel">\u53D6\u6D88\u767B\u5F55</button>
    </div>
  </div>

  <div class="card">
    <h2>\u8FD0\u884C\u65E5\u5FD7</h2>
    <div id="logs"><div>\uFF08\u6682\u65E0\uFF09</div></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let polling = false;
const STATUS = { running: '\u8FD0\u884C\u4E2D', 'needs-login': '\u9700\u8981\u767B\u5F55', starting: '\u542F\u52A8\u4E2D', stopped: '\u5DF2\u505C\u6B62' };
const LOGIN_LABELS = {
  wait: '\u7B49\u5F85\u626B\u7801\u2026', scaned: '\u5DF2\u626B\u7801\uFF0C\u6B63\u5728\u9A8C\u8BC1\u2026', confirmed: '\u7ED1\u5B9A\u6210\u529F \u2713',
  expired: '\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F', need_verifycode: '\u8BF7\u5728\u624B\u673A\u4E0A\u8F93\u5165\u914D\u5BF9\u7801',
  verify_code_blocked: '\u914D\u5BF9\u7801\u591A\u6B21\u9519\u8BEF\uFF0C\u5DF2\u5237\u65B0\u4E8C\u7EF4\u7801',
  scaned_but_redirect: '\u6B63\u5728\u5207\u6362\u8282\u70B9\u2026', 'already-connected': '\u8BE5\u5FAE\u4FE1\u5DF2\u7ED1\u5B9A\u8FC7\u672C\u673A',
};
const QR_IMG = (u) => 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(u);

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || ('HTTP ' + res.status));
  return data;
}

function fmtTs(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }

async function refreshStatus() {
  try {
    const r = await fetch('/clawbot/api/status');
    const s = await r.json();
    $('phase').textContent = STATUS[s.phase] || s.phase;
    $('phase').className = 'badge ' + s.phase;
    $('accountId').textContent = s.account ? s.account.accountId : '-';
    $('userId').textContent = s.account && s.account.userId ? s.account.userId : '-';
    $('dshBase').textContent = s.dsh ? s.dsh.baseUrl : '-';
    $('lastPoll').textContent = fmtTs(s.lastPollAt);
    $('lastError').textContent = s.lastError || '-';
    // Logs
    const logs = $('logs');
    logs.innerHTML = '';
    for (const l of s.logs.slice(-80)) {
      const d = document.createElement('div');
      d.className = 't-' + l.level;
      d.textContent = fmtTs(l.at) + '  [' + l.level + '] ' + l.msg;
      logs.appendChild(d);
    }
    logs.scrollTop = logs.scrollHeight;
    // Login UI
    const l = s.login;
    if (l && l.active && l.qrcodeUrl) {
      $('loginCard').style.display = '';
      $('qr').innerHTML = '<img src="' + QR_IMG(l.qrcodeUrl) + '" alt="\u626B\u7801\u767B\u5F55"><a href="' + l.qrcodeUrl + '" target="_blank">' + l.qrcodeUrl + '</a>';
      const label = LOGIN_LABELS[l.status] || l.status;
      $('loginStatus').textContent = label + (l.status === 'expired' ? '\uFF08\u5DF2\u81EA\u52A8\u5237\u65B0\uFF09' : '');
      if (l.status === 'need_verifycode') {
        $('verifyBox').style.display = 'flex';
      } else if (l.status !== 'confirmed') {
        $('verifyBox').style.display = 'none';
      }
      if (l.status === 'confirmed' && !polling) { startLoginPoll(); }
    } else {
      $('loginCard').style.display = 'none';
      $('verifyBox').style.display = 'none';
      polling = false;
    }
  } catch (err) {
    $('lastError').textContent = '\u72B6\u6001\u5237\u65B0\u5931\u8D25: ' + err.message;
  }
}

async function startLoginPoll() {
  if (polling) return;
  polling = true;
  try {
    while (polling) {
      const r = await api('/clawbot/api/login/poll', {});
      if (r.status === 'confirmed') { polling = false; $('loginStatus').textContent = '\u2705 ' + (r.message || '\u7ED1\u5B9A\u6210\u529F'); setTimeout(refreshStatus, 1000); return; }
      if (r.status === 'none' || r.status === 'expired' && r.ok === false) { polling = false; refreshStatus(); return; }
      await refreshStatus();
      if (r.status === 'need_verifycode') { polling = false; return; } // wait for user input
    }
  } catch (err) {
    polling = false;
    $('loginStatus').textContent = '\u8F6E\u8BE2\u5931\u8D25: ' + err.message;
  }
}

$('btnLogin').onclick = async () => {
  $('btnLogin').disabled = true;
  try {
    const r = await api('/clawbot/api/login/start', { force: true });
    $('btnLogin').disabled = false;
    if (!polling) startLoginPoll();
    await refreshStatus();
  } catch (err) {
    $('btnLogin').disabled = false;
    $('lastError').textContent = '\u53D1\u8D77\u767B\u5F55\u5931\u8D25: ' + err.message;
  }
};

$('btnVerify').onclick = async () => {
  const code = $('verifyInput').value.trim();
  if (!code) return;
  $('verifyInput').value = '';
  $('verifyBox').style.display = 'none';
  startLoginPoll();
  const r = await api('/clawbot/api/login/poll', { verifyCode: code });
  if (r.status === 'need_verifycode') { $('verifyBox').style.display = 'flex'; }
  await refreshStatus();
};

$('btnCancel').onclick = async () => {
  await api('/clawbot/api/login/cancel', {});
  polling = false;
  await refreshStatus();
};

$('btnUnbind').onclick = async () => {
  if (!confirm('\u786E\u5B9A\u89E3\u7ED1\u5F53\u524D\u5FAE\u4FE1\u8D26\u53F7\uFF1F\u89E3\u7ED1\u540E\u901A\u9053\u6682\u505C\uFF0C\u9700\u91CD\u65B0\u626B\u7801\u7ED1\u5B9A\u3002')) return;
  try {
    const r = await api('/clawbot/api/unbind', {});
    alert(r.message || '\u5DF2\u89E3\u7ED1');
    await refreshStatus();
  } catch (err) { alert('\u89E3\u7ED1\u5931\u8D25: ' + err.message); }
};

setInterval(refreshStatus, 5000);
refreshStatus();
</script>
</body>
</html>`;
}
export {
  renderPage
};

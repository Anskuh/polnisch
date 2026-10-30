// Sync über eine Datei in einem privaten GitHub-Repo. Jedes Gerät lädt den Stand, führt ihn mit dem eigenen
// zusammen und lädt das Ergebnis wieder hoch. Der Token bleibt lokal auf dem Gerät und landet nie im Backup.
const SYNC_KEY = 'polnisch-sync';
const SYNC_FILE = 'progress.json';
const SYNCED_SETTINGS = ['newPerDay', 'maxReviews', 'blockMinutes', 'dirs'];
const syncState = { busy: false, again: false, timer: null, last: 0, msg: '', error: false };

const deviceId = (() => {
  try {
    let id = localStorage.getItem('polnisch-device');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('polnisch-device', id); }
    return id;
  } catch (e) { return 'local'; }
})();

function syncCfg() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) { return null; }
}

// ---------- Zusammenführen ----------
function sortedObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}
function payload() {
  const settings = {};
  for (const k of SYNCED_SETTINGS) settings[k] = S.settings[k];
  return { v: 2, gen: S.gen, cards: sortedObj(S.cards), log: sortedObj(S.log), overrides: sortedObj(S.overrides), settings, settingsU: S.settingsU };
}
// Tageszähler pro Gerät: je Gerät gilt der höchste Stand, die Summe ergibt den Tag.
function mergeDay(a, b) {
  const d = {};
  for (const src of [a.d || {}, b.d || {}]) {
    for (const [dev, counts] of Object.entries(src)) {
      const t = d[dev] || (d[dev] = {});
      for (const [f, n] of Object.entries(counts)) t[f] = Math.max(t[f] || 0, n);
    }
  }
  const out = { done: !!(a.done || b.done), d: sortedObj(d) };
  for (const f of COUNTERS) out[f] = Object.values(d).reduce((sum, c) => sum + (c[f] || 0), 0);
  return out;
}
function mergeRemote(r) {
  const rGen = r.gen || 0;
  if (rGen > S.gen) { // Reset oder Import auf dem anderen Gerät: dessen Stand ersetzt alles
    S.gen = rGen; S.cards = r.cards; S.log = r.log; S.overrides = r.overrides || {}; S.session = null;
    Object.assign(S.settings, r.settings); S.settingsU = r.settingsU || 0;
    return;
  }
  if (rGen < S.gen) return;
  for (const [k, c] of Object.entries(r.cards)) {
    const mine = S.cards[k];
    if (!mine || (c.u || 0) > (mine.u || 0)) S.cards[k] = c;
  }
  for (const [day, L] of Object.entries(r.log)) S.log[day] = S.log[day] ? mergeDay(S.log[day], L) : L;
  for (const [i, o] of Object.entries(r.overrides || {})) {
    const mine = S.overrides[i];
    if (!mine || (o[2] || 0) > (mine[2] || 0)) S.overrides[i] = o;
  }
  if ((r.settingsU || 0) > S.settingsU) { Object.assign(S.settings, r.settings); S.settingsU = r.settingsU; }
}

// ---------- GitHub ----------
function toB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
}
async function gh(cfg, method, body) {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${SYNC_FILE}`, {
    method, cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('Token ungültig oder abgelaufen.');
  if (res.status === 403) throw new Error('Keine Berechtigung: Der Token braucht „Contents: Read and write“ für dieses Repo.');
  return res;
}
async function syncOnce(cfg) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const get = await gh(cfg, 'GET');
    let sha, raw = null;
    if (get.ok) {
      const file = await get.json();
      if (file.encoding !== 'base64') throw new Error('Sync-Datei ist zu groß.');
      sha = file.sha; raw = fromB64(file.content);
      const remote = JSON.parse(raw); // kaputte Datei: Abbruch, ohne etwas zu überschreiben
      if (!remote.cards || !remote.log) throw new Error('Sync-Datei ist ungültig.');
      mergeRemote(remote);
      save();
    } else if (get.status !== 404) throw new Error('GitHub-Fehler ' + get.status);

    const text = JSON.stringify(payload());
    if (text === raw) return;
    const put = await gh(cfg, 'PUT', {
      message: `Fortschritt ${dayKey()} (${deviceId})`,
      content: toB64(text),
      ...(sha ? { sha } : {}),
    });
    if (put.ok) return;
    if (put.status === 404) throw new Error('Repo nicht gefunden, oder der Token hat keinen Zugriff darauf.');
    if (put.status !== 409 && put.status !== 422) throw new Error('GitHub-Fehler ' + put.status);
    // 409/422: das andere Gerät war schneller, also neu laden und nochmal zusammenführen
  }
  throw new Error('Konflikt beim Speichern, nächster Versuch folgt automatisch.');
}
async function syncNow() {
  const cfg = syncCfg();
  if (!cfg) return;
  if (syncState.busy) { syncState.again = true; return; }
  syncState.busy = true;
  clearTimeout(syncState.timer);
  setSyncMsg('Synchronisiere…', false);
  try {
    await syncOnce(cfg);
    syncState.last = Date.now();
    setSyncMsg('Synchronisiert um ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), false);
    onSynced();
  } catch (e) {
    const offline = e instanceof TypeError || !navigator.onLine;
    setSyncMsg(offline ? 'Offline: wird später synchronisiert.' : e.message, !offline);
  }
  syncState.busy = false;
  if (syncState.again) { syncState.again = false; syncNow(); }
}
function scheduleSync(delay) {
  if (!syncCfg()) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(syncNow, delay);
}
function onSynced() {
  if (view === 'home') renderHome();
}

// ---------- Oberfläche ----------
function setSyncMsg(msg, error) {
  syncState.msg = msg; syncState.error = error;
  const el = document.getElementById('syncStatus');
  if (el) { el.textContent = msg; el.className = 'd ' + (error ? 'syncerr' : ''); }
}
function syncCard() {
  const cfg = syncCfg();
  if (cfg) {
    return `<div class="card">
      <div class="set"><div><label>Sync mit GitHub</label><div class="d">Verbunden mit ${esc(cfg.repo)}</div>
        <div class="d ${syncState.error ? 'syncerr' : ''}" id="syncStatus">${esc(syncState.msg)}</div></div>
        <button class="btn" onclick="syncNow()">Jetzt syncen</button></div>
      <div class="set"><div><label>iPhone verbinden</label><div class="d">Zeigt einen QR-Code mit dem Link zur App und den Sync-Daten.</div></div>
        <button class="btn" onclick="toggleQr()">${syncState.showQr ? 'QR-Code ausblenden' : 'QR-Code zeigen'}</button></div>
      ${syncState.showQr ? `<div class="qr-box">${setupQrSvg(cfg)}</div>
        <ol class="steps">
          <li>Mit der iPhone-Kamera scannen und den Link in Safari öffnen.</li>
          <li>Den Schritten auf dem iPhone folgen.</li>
        </ol>
        <p class="note">Der Code enthält deinen Zugangs-Token: nicht fotografieren oder weitergeben.</p>` : ''}
      <div class="set"><div><label>Verbindung trennen</label><div class="d">Entfernt den Token von diesem Gerät. Dein Fortschritt bleibt erhalten.</div></div>
        <button class="btn" onclick="syncDisconnect()">Trennen</button></div>
    </div>`;
  }
  return `<div class="card">
    <label><b>Sync mit GitHub</b></label>
    <div class="d small muted">Hält Laptop und iPhone auf demselben Stand. Auf jedem Gerät einmal eintragen.</div>
    <input class="field" id="syncRepo" placeholder="benutzername/polnisch-progress" autocapitalize="off" autocorrect="off" spellcheck="false">
    <input class="field" id="syncToken" type="password" placeholder="GitHub-Token (github_pat_…)" autocapitalize="off" autocorrect="off" spellcheck="false">
    <div class="d small syncerr" id="syncStatus" style="margin-top:8px"></div>
    <div class="actions" style="justify-content:flex-start;margin-top:12px"><button class="btn primary" onclick="syncConnect()">Verbinden</button></div>
  </div>`;
}
async function connectWith(repo, token) {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ repo, token }));
  await syncNow();
  if (!syncState.error) return true;
  const msg = syncState.msg; // falsche Angaben nicht speichern
  localStorage.removeItem(SYNC_KEY);
  setSyncMsg(msg, true);
  return false;
}
async function syncConnect() {
  const repo = document.getElementById('syncRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const token = document.getElementById('syncToken').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { setSyncMsg('Bitte im Format benutzername/repo eintragen.', true); return; }
  if (!token) { setSyncMsg('Bitte den Token eintragen.', true); return; }
  if (await connectWith(repo, token)) renderSettings();
}

// ---------- iPhone einrichten per QR-Code ----------
const APP_URL = 'https://anskuh.github.io/polnisch/';
const encodeSetup = cfg => btoa(JSON.stringify({ repo: cfg.repo, token: cfg.token }));
function decodeSetup(code) {
  const cfg = JSON.parse(atob(code.trim()));
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo || '') || !cfg.token) throw new Error('unvollständig');
  return cfg;
}
function setupQrSvg(cfg) {
  const qr = qrcode(0, 'L');
  qr.addData(`${APP_URL}#setup=${encodeURIComponent(encodeSetup(cfg))}`);
  qr.make();
  return qr.createSvgTag({ scalable: true, margin: 2 });
}
function toggleQr() {
  syncState.showQr = !syncState.showQr;
  renderSettings();
}
// Der Code aus dem QR-Link enthält den Token, also sofort aus der Adresse entfernen.
function takeSetupCode() {
  const m = /^#setup=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}
function isIos() { return /iPad|iPhone|iPod/.test(navigator.userAgent); }
function isInstalled() { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }
function needsSetup() {
  return !syncCfg() && !Object.keys(S.cards).length && (isIos() || isInstalled()) && !localStorage.getItem('polnisch-nosetup');
}
let setupCode = null;
function renderSetup(code) {
  setupCode = code;
  view = 'setup';
  const skip = `<p class="note"><button class="link" onclick="skipSetup()">Ohne Sync weiter</button></p>`;
  // Auf dem iPhone haben Safari und die installierte App getrennte Speicher, der Code muss also mit hinüber.
  if (isIos() && !isInstalled()) {
    app.innerHTML = `<div class="card">
      <h2 style="margin-top:0">App aufs iPhone holen</h2>
      <ol class="steps">
        ${code ? `<li><button class="btn primary" id="copyBtn" onclick="copySetup()">Einrichtungscode kopieren</button></li>`
          : `<li>Am Laptop unter Einstellungen → Sync mit GitHub den QR-Code zeigen, scannen und hierher zurückkommen.</li>`}
        <li>In Safari auf <b>Teilen</b> tippen, dann <b>Zum Home-Bildschirm</b>.</li>
        <li><b>Polnisch</b> vom Home-Bildschirm öffnen und den Code einfügen.</li>
      </ol>
      ${skip}
    </div>`;
    return;
  }
  app.innerHTML = `<div class="card">
    <h2 style="margin-top:0">Gerät verbinden</h2>
    <p class="muted">Füge den Einrichtungscode ein. Du bekommst ihn am Laptop unter Einstellungen → Sync mit GitHub.</p>
    <textarea class="field" id="setupInput" rows="3" placeholder="Einrichtungscode" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(code || '')}</textarea>
    <div class="d small syncerr" id="syncStatus" style="margin-top:8px"></div>
    <div class="actions" style="justify-content:flex-start;margin-top:12px">
      ${navigator.clipboard && navigator.clipboard.readText ? `<button class="btn" onclick="pasteSetup()">Einfügen</button>` : ''}
      <button class="btn primary" onclick="connectSetup()">Verbinden</button>
    </div>
    ${skip}
  </div>`;
}
async function copySetup() {
  const btn = document.getElementById('copyBtn');
  try {
    await navigator.clipboard.writeText(setupCode);
    btn.textContent = 'Kopiert ✓';
  } catch (e) {
    btn.textContent = 'Kopieren fehlgeschlagen, bitte nochmal tippen';
  }
}
async function pasteSetup() {
  try {
    document.getElementById('setupInput').value = await navigator.clipboard.readText();
  } catch (e) {
    setSyncMsg('Bitte lange ins Feld tippen und „Einsetzen“ wählen.', true);
  }
}
async function connectSetup() {
  let cfg;
  try { cfg = decodeSetup(document.getElementById('setupInput').value); }
  catch (e) { setSyncMsg('Das ist kein gültiger Einrichtungscode.', true); return; }
  setSyncMsg('Verbinde…', false);
  if (await connectWith(cfg.repo, cfg.token)) go('home');
}
function skipSetup() {
  localStorage.setItem('polnisch-nosetup', '1');
  go('home');
}
function syncDisconnect() {
  localStorage.removeItem(SYNC_KEY);
  syncState.msg = ''; syncState.error = false;
  renderSettings();
}
function initSync() {
  scheduleSync(0);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) syncNow();
    else if (Date.now() - syncState.last > 60000) scheduleSync(0);
  });
  window.addEventListener('online', () => scheduleSync(0));
}

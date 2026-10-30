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
async function syncConnect() {
  const repo = document.getElementById('syncRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const token = document.getElementById('syncToken').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { setSyncMsg('Bitte im Format benutzername/repo eintragen.', true); return; }
  if (!token) { setSyncMsg('Bitte den Token eintragen.', true); return; }
  localStorage.setItem(SYNC_KEY, JSON.stringify({ repo, token }));
  await syncNow();
  if (syncState.error) { // falsche Angaben nicht speichern
    const msg = syncState.msg;
    localStorage.removeItem(SYNC_KEY);
    setSyncMsg(msg, true);
    return;
  }
  renderSettings();
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

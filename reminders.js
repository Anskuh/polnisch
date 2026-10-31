// Erinnerungen aufs Handy. Eine Web-App kann auf dem iPhone nichts selbst planen, deshalb verschickt ein geplanter
// Lauf im privaten Sync-Repo die Nachrichten. Dafür meldet sich das Gerät dort in push.json an.
const VAPID_PUBLIC = 'BOE3-DifZbwOTuJRuX5nTIhdPFH1a2-zw6Q9jbfkJTH1OpYu44IlyBSOAqF2VIDgm5Qr5QiQv1ThAM0NFpzuXS0';
const PUSH_FILE = 'push.json';
const REMINDER_KEY = 'polnisch-reminders'; // zuletzt angemeldeter Endpunkt, fehlt = aus
const DAILY_BLOCKS = 5;
const reminderState = { msg: '', error: false, busy: false };

const pushSupported = () => (location.protocol === 'https:' || location.hostname === 'localhost')
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const remindersOn = () => !!localStorage.getItem(REMINDER_KEY);

function vapidKey() {
  const b64 = VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
}
// Liest push.json, ändert den eigenen Eintrag und speichert. Bei gleichzeitigen Änderungen nochmal von vorn.
async function updatePushFile(cfg, sub) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const get = await gh(cfg, 'GET', null, PUSH_FILE);
    let sha, data = { subs: {} };
    if (get.ok) {
      const file = await get.json();
      sha = file.sha; data = JSON.parse(fromB64(file.content));
    } else if (get.status !== 404) throw new Error('GitHub-Fehler ' + get.status);
    if (!sub && !data.subs[deviceId]) return;
    if (sub) data.subs[deviceId] = sub; else delete data.subs[deviceId];
    const put = await gh(cfg, 'PUT', {
      message: `Erinnerungen ${sub ? 'an' : 'aus'} (${deviceId})`,
      content: toB64(JSON.stringify(data)),
      ...(sha ? { sha } : {}),
    }, PUSH_FILE);
    if (put.ok) return;
    if (put.status !== 409 && put.status !== 422) throw new Error('GitHub-Fehler ' + put.status);
  }
  throw new Error('Konflikt beim Speichern, bitte nochmal versuchen.');
}
async function subscribePush(reg) {
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() });
  const { endpoint, keys } = sub.toJSON();
  await updatePushFile(syncCfg(), { endpoint, keys, u: Date.now() });
  localStorage.setItem(REMINDER_KEY, endpoint);
}
function reminderDone(msg, error) {
  reminderState.msg = msg; reminderState.error = error; reminderState.busy = false;
  if (view === 'settings') renderSettings();
}
async function enableReminders() {
  reminderState.busy = true;
  try {
    const permission = await Notification.requestPermission(); // muss direkt auf den Tipp folgen
    if (permission !== 'granted') {
      reminderDone('Mitteilungen sind nicht erlaubt.', true);
      return;
    }
    await subscribePush(await navigator.serviceWorker.ready);
    reminderDone('Fertig! In etwa einer Minute kommt eine Bestätigung aufs Handy.', false);
  } catch (e) {
    reminderDone(e instanceof TypeError ? 'Keine Verbindung. Bitte online nochmal versuchen.' : e.message, true);
  }
}
async function disableReminders() {
  reminderState.busy = true;
  try {
    await updatePushFile(syncCfg(), null);
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    localStorage.removeItem(REMINDER_KEY);
    reminderDone('Erinnerungen sind aus.', false);
  } catch (e) {
    reminderDone(e instanceof TypeError ? 'Keine Verbindung. Bitte online nochmal versuchen.' : e.message, true);
  }
}
function reminderCard() {
  let body;
  if (!pushSupported()) {
    body = isIos() && !isInstalled()
      ? 'Öffne die App dafür vom Home-Bildschirm.'
      : isIos() ? 'Dafür brauchst du mindestens iOS 16.4.' : 'Stell die Erinnerungen in der App auf dem iPhone ein.';
  } else if (!syncCfg()) {
    body = 'Verbinde dafür zuerst den Sync mit GitHub.';
  } else if (Notification.permission === 'denied') {
    body = 'Mitteilungen sind blockiert. Erlaube sie in den iPhone-Einstellungen unter Mitteilungen → Polnisch.';
  }
  const on = remindersOn();
  const button = body ? '' : `<button class="btn ${on ? '' : 'primary'}" ${reminderState.busy ? 'disabled' : ''} onclick="${on ? 'disableReminders' : 'enableReminders'}()">${on ? 'Ausschalten' : 'Einschalten'}</button>`;
  return `<div class="card">
    <div class="set"><div><label>Erinnerungen</label>
      <div class="d">${body || `Gegen 9, 12, 15, 18 und 20:30 Uhr, mit einem Wort zum Abfragen. Bist du schon im Plan oder heute fertig, bleibt das Handy still.`}</div>
      ${reminderState.msg ? `<div class="d ${reminderState.error ? 'syncerr' : ''}">${esc(reminderState.msg)}</div>` : ''}</div>
      ${button}</div>
  </div>`;
}
// Offene Blöcke als Zahl am App-Symbol.
function updateBadge(L) {
  if (!navigator.setAppBadge || !remindersOn()) return;
  const left = L.done ? 0 : Math.max(0, DAILY_BLOCKS - (L.blocks || 0));
  (left ? navigator.setAppBadge(left) : navigator.clearAppBadge()).catch(() => {});
}
// Das Handy kann die Anmeldung still erneuern. Dann muss der neue Endpunkt ins Repo.
async function initReminders() {
  if (!pushSupported() || !remindersOn() || !syncCfg() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || sub.endpoint !== localStorage.getItem(REMINDER_KEY)) await subscribePush(reg);
  } catch (e) {} // beim nächsten Start nochmal
}

// Hält die App offline verfügbar. Alle Dateien einer Version liegen zusammen im Speicher. Die App startet immer
// sofort von dort, auch bei schlechtem Netz. Eine neue Version wird im Hintergrund komplett geladen und gilt ab
// dem nächsten Start, damit sich alte und neue Dateien nie mischen. Die Version ergibt sich aus dem Dateiinhalt.
const PREFIX = 'polnisch-';
const META = PREFIX + 'meta';
const CURRENT = 'current';
const FILES = ['index.html', 'words.js', 'qrcode.js', 'sync.js', 'reminders.js', 'manifest.webmanifest', 'icon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const scoped = path => new URL(path, self.registration.scope).href;

async function currentName() {
  const res = await (await caches.open(META)).match(CURRENT);
  return res ? res.text() : null;
}
async function download() {
  return Promise.all(FILES.map(async file => {
    const res = await fetch(scoped(file), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Konnte ${file} nicht laden`);
    return { file, type: res.headers.get('Content-Type') || '', body: await res.arrayBuffer() };
  }));
}
async function versionOf(parts) {
  const total = parts.reduce((n, p) => n + p.body.byteLength, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(new Uint8Array(p.body), at); at += p.body.byteLength; }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(hash.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}
// Erst wenn alles gespeichert ist, wird die neue Version zur aktuellen.
async function update() {
  const parts = await download();
  const name = PREFIX + await versionOf(parts);
  if (await currentName() === name) return;
  const cache = await caches.open(name);
  await Promise.all(parts.map(p => cache.put(scoped(p.file), new Response(p.body, { headers: { 'Content-Type': p.type } }))));
  await (await caches.open(META)).put(CURRENT, new Response(name));
  for (const key of await caches.keys()) {
    if (key.startsWith(PREFIX) && key !== name && key !== META) await caches.delete(key);
  }
}

self.addEventListener('install', e => e.waitUntil(update().then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Erinnerungen: Jede Nachricht muss sichtbar werden, sonst entzieht iOS der App die Erlaubnis.
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data.json(); } catch (err) {}
  const jobs = [self.registration.showNotification(msg.title || 'Polnisch', {
    body: msg.body || 'Zeit für einen Block.',
    icon: scoped('icon-192.png'),
    tag: 'polnisch-reminder', // ersetzt eine ältere, damit sich nichts stapelt
  })];
  if (self.navigator.setAppBadge && typeof msg.left === 'number') jobs.push(self.navigator.setAppBadge(msg.left).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open.length) return open[0].focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});

let checking = null;
function checkForUpdate() {
  if (!checking) checking = update().catch(() => {}).finally(() => { checking = null; });
  return checking;
}
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  const isPage = request.mode === 'navigate';
  e.respondWith((async () => {
    const name = await currentName();
    const url = new URL(request.url);
    url.hash = ''; url.search = '';
    const hit = name && await (await caches.open(name)).match(isPage ? scoped('index.html') : url.href);
    if (isPage) e.waitUntil(checkForUpdate());
    return hit || fetch(request);
  })());
});

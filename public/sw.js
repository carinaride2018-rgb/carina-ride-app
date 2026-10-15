// Service worker: makes the app installable, opens it quickly (and offline,
// with the last screens it loaded), and handles taps on notifications.
'use strict';
const CACHE = 'livery-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'core.js', 'native.js', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// App files: use the network when it's there so updates show at once, fall back to the cache.
// API calls and videos (media/) always go to the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))));
});
// Tapping a notification opens the app on the right screen.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.hash ? './' + e.notification.data.hash : './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate && c.navigate(target); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
// Web Push from the server: { title, body, hash, tag }. Shown when the app is
// closed or in the background; an app on screen shows its own banner instead.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'LimoRelay', body: e.data && e.data.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    if (list.some((c) => c.visibilityState === 'visible' && c.focused)) return null;
    return self.registration.showNotification(d.title || 'LimoRelay', { body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: d.tag, data: { hash: d.hash || '' } });
  }));
});

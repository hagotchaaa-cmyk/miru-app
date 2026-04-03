// sw.js — Miru service worker for push notifications

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Push received ─────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Miru', body: 'You have a new notification', url: '/index.html' };

  try {
    if (e.data) data = { ...data, ...e.data.json() };
  } catch (_) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/icon-180.png',
      badge:   '/icon-180.png',
      tag:     data.tag || 'miru-notif',
      data:    { url: data.url || '/index.html' },
      vibrate: [100, 50, 100],
    })
  );
});

// ── Notification tapped ───────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/index.html';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // If app is already open, focus it
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

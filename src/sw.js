// Hermes-web service worker — periodic background sync + notifications.
// Periodic sync can fire while the app tab is closed; the SW notifies any
// live client and shows a notification when none are open. While-online
// cron scheduling itself lives in upstream Hermes (tools.cronjob_tools).

self.addEventListener('install', (e) => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()))

self.addEventListener('periodicsync', (e) => {
  e.waitUntil((async () => {
    const cs = await clients.matchAll({ includeUncontrolled: true })
    for (const c of cs) c.postMessage({ type: 'periodic-sync', tag: e.tag })
    if (cs.length === 0) {
      await self.registration.showNotification('Hermes', {
        body: 'Scheduled sync: ' + e.tag,
        tag: 'hermes-' + e.tag,
      })
    }
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => {
    if (cs.length) return cs[0].focus()
    return clients.openWindow('./index.html')
  }))
})

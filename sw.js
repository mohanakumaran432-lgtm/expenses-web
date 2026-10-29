// Minimal service worker: makes the app installable on Android.
// It deliberately caches NOTHING, so no private financial data (or app code)
// is ever stored for offline use. Cross-origin requests (Supabase) are never touched.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.mode !== 'navigate') return // everything else: plain network, default browser handling
  event.respondWith(
    fetch(req).catch(
      () =>
        new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2rem"><h2>You are offline</h2><p>Family Ledger needs a connection. Your data is never stored on this device.</p>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    ),
  )
})

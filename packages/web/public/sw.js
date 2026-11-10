// Sudare service worker. Hand-written, no build step.
// - navigations: network first, cached app shell as the offline fallback
// - hashed assets: cached after first use
// - /api/* and the server-rendered OAuth pages are never touched
// - push: payload-free by design, so the notification is always generic

const CACHE = 'sudare-shell-v1'
const SHELL = '/'
const SERVER_PATHS = ['/api', '/authorize', '/oauth', '/.well-known', '/mcp', '/admin']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).catch(() => undefined).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

const store = async (key, response) => {
  if (response.ok && response.type === 'basic') (await caches.open(CACHE)).put(key, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (SERVER_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => store(SHELL, res)).catch(async () => (await caches.match(SHELL)) ?? Response.error()),
    )
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => store(req, res))))
  }
})

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Sudare', {
      body: 'Something is waiting for you',
      tag: 'sudare',
      icon: '/icon.svg',
      badge: '/icon.svg',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin)
      return open ? open.focus() : self.clients.openWindow('/')
    }),
  )
})

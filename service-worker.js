const CACHE_NAME = 'iaptidud-supervision-v7';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './supabase-sync.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

async function addSupabaseSyncScript(response) {
  if (!response) return response;

  const text = await response.text();

  if (text.includes('<script src="./supabase-sync.js"></script>')) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  const bodyCloseIndex = text.lastIndexOf('</body>');
  const patched = bodyCloseIndex >= 0
    ? text.slice(0, bodyCloseIndex) + '<script src="./supabase-sync.js"></script>\n' + text.slice(bodyCloseIndex)
    : text;

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.delete('Content-Length');

  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(event.request);
        const patchedResponse = await addSupabaseSyncScript(networkResponse);
        const copy = patchedResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
        return patchedResponse;
      } catch (error) {
        const cached = await caches.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        });
      })
    );
  }
});

const CACHE_NAME = 'iaptidud-supervision-v16';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './install-helper.js',
  './supabase-auth.js',
  './supabase-sync.js',
  './audit-log.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();

    // Fuerza una recarga al activar esta versión para incorporar Auth,
    // sincronización y trazabilidad en todos los dispositivos.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(client => client.navigate(client.url).catch(() => null)));
  })());
});

async function addAppScripts(response) {
  if (!response) return response;

  let text = await response.text();
  const installScript = '<script src="./install-helper.js"></script>';
  const syncScript = '<script src="./supabase-sync.js"></script>';
  const auditScript = '<script src="./audit-log.js"></script>';

  // La instalación debe capturarse temprano, antes de que termine de cargar la página.
  if (!text.includes(installScript)) {
    const headCloseIndex = text.lastIndexOf('</head>');
    if (headCloseIndex >= 0) {
      text = text.slice(0, headCloseIndex) + installScript + '\n' + text.slice(headCloseIndex);
    }
  }

  // Auth se carga directamente desde index.html. Sincronización y trazabilidad
  // se agregan al final del body, en ese orden, para envolver las funciones finales.
  const bodyCloseIndex = text.lastIndexOf('</body>');
  if (bodyCloseIndex >= 0) {
    let scripts='';
    if (!text.includes(syncScript)) scripts += syncScript + '\n';
    if (!text.includes(auditScript)) scripts += auditScript + '\n';
    if (scripts) {
      text = text.slice(0, bodyCloseIndex) + scripts + text.slice(bodyCloseIndex);
    }
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.delete('Content-Length');

  return new Response(text, {
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
        const patchedResponse = await addAppScripts(networkResponse);
        const copy = patchedResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
        return patchedResponse;
      } catch (error) {
        const cached = await caches.match('./index.html');
        return cached ? addAppScripts(cached) : Response.error();
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
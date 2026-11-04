'use strict';

// Offline support. Every file is served from the cache first and refreshed
// from the network in the background, so a new deploy shows on the next load.
// Videos come from another site and stream, so they are not cached here.
// content-update/ must always show what is on the site, so it skips the cache.

const CACHE = 'bdl-v2';
const SHELL = './';

// Content is read only when a study screen opens; fetch it up front so every
// screen works offline after the first visit.
const CONTENT = ['questions.json', 'keywords.json', 'glossary.json', 'config.json', 'version.json']
  .map((f) => `assets/assets/content/${f}`);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.add(SHELL);
    await Promise.all(CONTENT.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// The page sends what it loaded before this worker took control.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-urls') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of event.data.urls) {
      if (!cacheable(new URL(url)) || isVideo(url) || await cache.match(url)) continue;
      try {
        await cache.add(url);
      } catch (_) {
        // One failed file must not stop the rest.
      }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url) || url.pathname.includes('/content-update/')) return;

  if (req.mode === 'navigate') {
    // Every app route is the same index.html (go_router handles the path).
    event.respondWith(staleWhileRevalidate(event, new Request(SHELL), req));
  } else if (req.headers.has('range')) {
    event.respondWith(rangeResponse(event, req));
  } else {
    event.respondWith(staleWhileRevalidate(event, req, req));
  }
});

function cacheable(url) {
  return url.origin === self.location.origin || url.hostname.endsWith('gstatic.com');
}

function isVideo(url) {
  return /\.(mp4|webm)(\?|$)/i.test(url);
}

async function staleWhileRevalidate(event, key, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  const network = fetch(req).then(async (res) => {
    if (res.ok || res.type === 'opaque') await cache.put(key, res.clone());
    return res;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

// <video> asks for byte ranges. Serve them from a cached full copy; if there
// is none yet, pass the request on and cache the full file in the background.
async function rangeResponse(event, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req.url);
  if (!cached) {
    event.waitUntil(fetch(req.url).then((res) => res.ok && cache.put(req.url, res)).catch(() => {}));
    return fetch(req);
  }
  const blob = await cached.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range'));
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

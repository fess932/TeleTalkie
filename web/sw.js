// Service Worker для TeleTalkie PWA

const CACHE_NAME = 'teletalkie-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json'
];

// Установка service worker
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching files');
        return cache.addAll(urlsToCache);
      })
      .catch((err) => {
        console.error('[SW] Cache failed:', err);
      })
  );
  self.skipWaiting();
});

// Активация service worker
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch - используем network-first стратегию для real-time приложения
self.addEventListener('fetch', (event) => {
  // Пропускаем WebSocket запросы
  if (event.request.url.includes('/ws')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

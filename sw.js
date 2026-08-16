const CACHE_NAME = 'skyfire-gps-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/solar-calc.js',
  './js/skyfire-engine.js',
  './js/geocoding.js',
  './js/spots-taiwan.js',
  './js/weather-service.js',
  './js/app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // 只快取同源靜態檔案，動態 API 請求優先網路
  if (e.request.url.includes('open-meteo.com') || e.request.url.includes('bigdatacloud') || e.request.url.includes('nominatim')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((res) => {
      return res || fetch(e.request);
    })
  );
});

// 每次改動前端資產都要 bump 這個版號：activate 只會刪掉 key 不等於 CACHE_NAME 的舊快取。
const CACHE_NAME = 'skyfire-gps-taiwan-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/taiwan-scope.js',
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
      // {cache:'reload'} 強制略過 HTTP 快取，否則全新的 v4 可能又從 GitHub Pages 的
      // max-age 回應重新灌入過期內容。
      return cache.addAll(ASSETS_TO_CACHE.map((u) => new Request(u, { cache: 'reload' })));
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
  if (e.request.method !== 'GET') return;
  // 只處理同源靜態檔案；氣象/逆地理 API 與 unpkg 上的 Leaflet 一律直接走網路。
  if (new URL(e.request.url).origin !== self.location.origin) return;

  // Network-first：永遠先拿最新版，成功就順手更新快取；離線時才回退到快取。
  // 舊版是 cache-first 且從不重新驗證，任何前端改動都要等 CACHE_NAME bump 才會傳到回訪者。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

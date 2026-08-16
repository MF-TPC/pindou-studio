/**
 * 格物 — Service Worker (V1)
 * 离线缓存策略: 核心资源预缓存，其他运行时缓存
 */

var CACHE = 'pindou-v1';
var ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/colormatch.js',
  'js/palettes.js',
  'js/dither.js',
  'js/converter.js',
  'js/resizer.js',
  'js/board.js',
  'js/importer.js',
  'js/assistant.js',
  'js/renderer.js',
  'js/exporter.js',
  'js/app.js',
  'manifest.json',
];

// Install: 预缓存核心资源
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: 清理旧缓存
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
          .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: 缓存优先，网络回退
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  // 跳过 CDN 资源
  var url = e.request.url;
  if (url.includes('cdn.jsdelivr.net') || url.includes('unpkg.com')) return;

  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) {
        // 后台更新缓存
        fetch(e.request).then(function(res) {
          if (res.ok) caches.open(CACHE).then(function(c) { return c.put(e.request, res); });
        }).catch(function() {});
        return cached;
      }
      return fetch(e.request).then(function(res) {
        if (!res.ok) return res;
        var clone = res.clone();
        caches.open(CACHE).then(function(c) { return c.put(e.request, clone); });
        return res;
      });
    })
  );
});

/**
 * 格物 — Service Worker (V2)
 * 离线缓存策略: 核心资源预缓存，其他运行时缓存。
 * 只缓存同源资源；跨域资源(CDN/OCR模型等)直接放行，避免干扰 OCR 模型下载。
 */

var CACHE = 'pindou-v2';
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

// Fetch: 同源缓存优先、网络回退；跨域直接放行
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);
  // 跨域(CDN / OCR 模型 / 字体等)不拦截，交给浏览器原生处理
  if (url.origin !== self.location.origin) return;

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

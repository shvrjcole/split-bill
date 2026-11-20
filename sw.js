/* Split-Bill service worker — offline cache, best-effort. */
var CACHE = 'splitbill-v1';
var ASSETS = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.svg', 'icons/icon-512.svg'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).catch(function () {}));
});
self.addEventListener('fetch', function (e) {
  e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }).catch(function () { return caches.match('index.html'); }));
});

/* 오프라인용 서비스 워커: 앱 파일을 저장해 두고 인터넷 없이도 연다.
 * 앱 파일을 고치면 VERSION을 바꿔야 폰에 새 버전이 받아진다(scripts/build-web.js가 자동으로 바꿈). */
var VERSION = 'v202611081453';
var FILES = ['./', 'index.html', 'style.css', 'app.js', 'midi2xml.js', 'store.js', 'midisynth.js', 'pack.js', 'tutorial.js',
  'lib/opensheetmusicdisplay.min.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// 네트워크 먼저(새 버전 반영), 안 되면 저장본
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true });
  }));
});

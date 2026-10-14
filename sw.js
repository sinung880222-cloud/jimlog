// 짐로그 서비스워커: 파일을 바꿀 때마다 CACHE 버전을 올린다 (v2, v3 …)
const CACHE = 'jimlog-v9';
const PRECACHE = ['./', 'index.html', 'manifest.webmanifest',
  'privacy.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
});

self.addEventListener('activate', e => {   // 이전 버전 캐시 삭제
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // 구글 로그인·드라이브 요청은 캐시하지 않고 그대로 통과
  if (/(^|\.)(accounts\.google\.com|googleapis\.com|gstatic\.com)$/.test(new URL(req.url).hostname)) return;
  if (req.mode === 'navigate') {   // 페이지: 네트워크 먼저(새 버전 바로 반영) → 실패하면 캐시
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('index.html', copy));
        return res;
      }).catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(   // 나머지: 캐시 먼저
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && new URL(req.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});

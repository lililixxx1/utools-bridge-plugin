// service worker — 仅缓存壳（index.html/manifest 等），不缓存 /api 请求
// 这样首次访问后即使断网也能打开 UI（数据请求会失败，但界面在）
// 改任何前端代码时必须升 CACHE 版本号，否则旧 index.html 会被永久缓存
const CACHE = 'utools-mobile-v8';

self.addEventListener('install', (e) => {
    // 不在 install 阶段预缓存。原因：本服务默认开启鉴权，install 时 fetch './'
    // 不带 ?key= 会被 401 拒掉，caches.addAll 对非 2xx 会 reject 导致整个 SW 安装失败。
    // 改由下方 fetch handler 在「首次成功响应」时动态填充缓存，等价且不依赖鉴权态。
    // install 立即完成并接管，不必等预缓存。
    self.skipWaiting();
    e.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // API 请求永远走网络，不缓存。显式 respondWith 避免 WebView 吞掉裸 return 的请求。
    if (url.pathname.startsWith('/api/')) {
        e.respondWith(fetch(e.request));
        return;
    }
    // 壳资源：网络优先（拿到新版），失败再回退缓存（离线兜底）
    // 缓存键去掉 query 串：首访 URL 形如 ./index.html?key=SECRET，若原样作 cache key，
    // 明文 key 会持久留在 CacheStorage 里（地址栏的 replaceState 抹不掉 SW 已存的 URL）。
    const cacheReq = url.search ? new Request(url.origin + url.pathname) : e.request;
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                // 只缓存同源成功响应
                if (res.ok && url.origin === self.location.origin) {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(cacheReq, copy));
                }
                return res;
            })
            .catch(() => caches.match(cacheReq).then((r) => r || caches.match(e.request)))
    );
});

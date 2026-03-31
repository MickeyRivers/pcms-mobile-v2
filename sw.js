// PCMS Service Worker v70
const CACHE_NAME = 'pcms-v87';

self.addEventListener('install', function(event) {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.map(function(k) { return caches.delete(k); }));
        }).then(function() { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function(event) {
    var url = event.request.url;

    // Skip external APIs
    if (url.includes('googleapis.com') || url.includes('script.google.com') ||
        url.includes('run.app') || url.includes('dropbox') ||
        url.includes('ocr.space') || url.includes('cdn-cgi')) {
        return;
    }

    // Always fetch HTML fresh - never serve from cache
    if (event.request.mode === 'navigate' || url.endsWith('.html') ||
        url.endsWith('/pcms-mobile-test/') || url.endsWith('/pcms-mobile-test')) {
        event.respondWith(
            fetch(event.request).catch(function() {
                return caches.match('./index.html');
            })
        );
        return;
    }

    // Cache other assets
    event.respondWith(
        caches.match(event.request).then(function(cached) {
            if (cached) return cached;
            return fetch(event.request).then(function(response) {
                if (event.request.method === 'GET' && response.status === 200) {
                    var clone = response.clone();
                    caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
                }
                return response;
            });
        })
    );
});

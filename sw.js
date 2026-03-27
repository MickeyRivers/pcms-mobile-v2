// PCMS Service Worker - Offline Cache + Background Sync
const CACHE_NAME = 'pcms-v67';
const SYNC_TAG = 'pcms-sync';

const CLOUD_FUNCTION_URL = 'https://generate-certificate-test2-980517620937.us-central1.run.app';
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbylCjhUdLU-Pg5mfjl16Qsf4-9uin-ZgD4T2qxhvVnnQ0dv8kMDQ6EZTEcNxosLfEZFmg/exec';

// App shell files to cache for offline use
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json'
];

// ─── Install: cache app shell ───────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(APP_SHELL).catch(() => {
                // Non-fatal: continue even if some assets fail
            });
        }).then(() => self.skipWaiting())
    );
});

// ─── Activate: clean old caches ─────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// ─── Fetch: serve from cache, fall back to network ──────────────────────────
self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Never intercept API calls or external services
    if (url.includes('googleapis.com') ||
        url.includes('script.google.com') ||
        url.includes('run.app') ||
        url.includes('dropbox') ||
        url.includes('ocr.space') ||
        url.includes('fonts.g')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                // Cache successful GET responses for app shell
                if (event.request.method === 'GET' && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline and not cached — return cached index.html for navigation
                if (event.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
            });
        })
    );
});

// ─── Background Sync (disabled — sync runs manually from the UI only) ────────
// self.addEventListener('sync', event => {
//     if (event.tag === SYNC_TAG) {
//         event.waitUntil(syncPendingTests());
//     }
// });

// ─── Push message from page: manual sync trigger ────────────────────────────
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'MANUAL_SYNC') {
        syncPendingTests().then(result => {
            // Notify all open clients of result
            self.clients.matchAll().then(clients => {
                clients.forEach(client => client.postMessage({
                    type: 'SYNC_COMPLETE',
                    result
                }));
            });
        });
    }
});

// ─── Core sync logic (runs in SW context) ────────────────────────────────────
async function syncPendingTests() {
    let db;
    try {
        db = await openDB();
    } catch (e) {
        return { success: 0, failed: 0, error: 'DB unavailable' };
    }

    const tests = await getAllPending(db);
    if (tests.length === 0) return { success: 0, failed: 0 };

    let successCount = 0;
    let failedCount = 0;

    for (const test of tests) {
        const ok = await syncOneTest(test);
        if (ok) {
            await deletePending(db, test.id);
            successCount++;
        } else {
            failedCount++;
        }
    }

    // Notify open clients to refresh their UI
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({
        type: 'SYNC_COMPLETE',
        result: { success: successCount, failed: failedCount }
    }));

    return { success: successCount, failed: failedCount };
}

async function syncOneTest(test) {
    // 1. Generate PDF certificate via Cloud Run
    let pdfOk = false;
    try {
        const pdfAbort = new AbortController();
        const pdfTimeout = setTimeout(() => pdfAbort.abort(), 30000);
        const res = await fetch(CLOUD_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(test),
            signal: pdfAbort.signal
        });
        clearTimeout(pdfTimeout);
        if (res.ok) {
            const json = await res.json();
            pdfOk = !!json.success;
        }
    } catch (e) {
        // Network failure or timeout — will retry on next sync
        return false;
    }

    // 2. Sync to Google Sheets (no-cors = no preflight, fire and forget)
    try {
        const sheetData = { ...test };
        delete sheetData.photos;
        sheetData.action = 'addFieldData';
        const fd = new FormData();
        fd.append('data', JSON.stringify(sheetData));
        fetch(SHEETS_URL, { method: 'POST', body: fd, mode: 'no-cors' });
    } catch (e) { /* best-effort */ }

    // 3. Update AssetDB (best-effort, no-cors)
    if (test.serialNumber) {
        try {
            const assetPayload = {
                action: 'updateAsset',
                serialNumber: test.serialNumber,
                customer: test.customer,
                location: test.location,
                serviceType: test.serviceType,
                manufacturer: test.manufacturer,
                pipeMaterial: test.pipeMaterial,
                pipeSize: test.pipeSize,
                deviceType: test.deviceType,
                range: test.range,
                units: test.units,
                method: test.method,
                waterType: test.waterType,
                gpsCoordinates: test.gpsCoordinates
            };
            const fd2 = new FormData();
            fd2.append('data', JSON.stringify(assetPayload));
            fetch(SHEETS_URL, { method: 'POST', body: fd2, mode: 'no-cors' });
        } catch (e) { /* best-effort */ }
    }

    // Test clears from queue if PDF succeeded (sheet is secondary)
    return pdfOk;
}

// ─── IndexedDB helpers (usable in SW context) ────────────────────────────────
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('pcms', 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('pending')) {
                db.createObjectStore('pending', { keyPath: 'id' });
            }
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => reject(req.error);
    });
}

function getAllPending(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pending', 'readonly');
        const req = tx.objectStore('pending').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

function deletePending(db, id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pending', 'readwrite');
        const req = tx.objectStore('pending').delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

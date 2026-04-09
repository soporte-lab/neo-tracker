/**
 * NeoRejuvenation Tracker — Service Worker (Fase 5, Paso 7)
 * =========================================================
 *
 * Cachea los assets estáticos del bundle Vite para arranque instantáneo
 * y soporte offline básico.
 *
 * NO gestiona push notifications: eso lo hace OneSignalSDKWorker.js
 * en el dominio padre (neorejuvenation.app).
 *
 * NO cachea HTML: el documento se sirve siempre desde red para que los
 * deploys nuevos se vean inmediatamente.
 *
 * NO cachea llamadas API: el iframe no hace fetches directos al backend
 * — todo pasa por postMessage al parent.
 *
 * Estrategia:
 *   - /assets/* → cache-first (archivos con hash, immutable)
 *   - todo lo demás → network-only (sin tocar)
 */

// Bump esta versión cuando cambies la lógica del SW para forzar update.
// NO la cambies en cada deploy del bundle — los archivos hashed se gestionan solos.
const CACHE_VERSION = 'nr-tracker-v1';
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

// ── INSTALL ──
// Skip waiting para activar el SW nuevo inmediatamente sin esperar al cierre de tabs.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// ── ACTIVATE ──
// Limpia caches viejos de versiones anteriores del SW.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('nr-tracker-') && !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      // Tomar control de las pestañas abiertas inmediatamente
      await self.clients.claim();
    })()
  );
});

// ── FETCH ──
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo gestionamos GET. POST/PUT/DELETE pasan tal cual.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Solo cacheamos requests del mismo origen (nuestro dominio Vercel).
  // Cualquier cosa cross-origin (CDN externos, fonts, etc.) pasa directa.
  if (url.origin !== self.location.origin) return;

  // Cachear assets versionados de Vite (/assets/*)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Todo lo demás (incluyendo el HTML raíz) → red directa, sin tocar.
  // Esto garantiza que un deploy nuevo se sirva inmediatamente.
});

/**
 * Cache-first: si está en cache, lo devolvemos; si no, fetch + cachear.
 * Si el fetch falla y no hay cache, propagamos el error al navegador.
 */
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Solo cacheamos respuestas OK (200-299) y básicas (no opaque)
    if (response.ok && response.type === 'basic') {
      // Clonar antes de cachear porque el body es un stream consumible una vez
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Sin red y sin cache → dejar que el navegador muestre su error nativo
    throw err;
  }
}

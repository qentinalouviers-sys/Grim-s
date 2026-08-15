/* ==========================================================================
 * sw.js — service worker
 * --------------------------------------------------------------------------
 * Stratégies, choisies par nature de ressource :
 *
 *   coque applicative   cache-first + revalidation en arrière-plan
 *                       → démarrage instantané, hors ligne garanti
 *   données du dépôt    stale-while-revalidate
 *                       → on affiche tout de suite, on met à jour si on peut
 *   Leaflet (CDN)       cache-first, jamais revalidé
 *                       → une version figée, téléchargée une fois
 *   tuiles carte        PAS ICI. Elles vivent dans IndexedDB (views/map.js),
 *                       parce qu'on veut les précharger explicitement par
 *                       zone, mesurer leur poids et pouvoir les purger. Le
 *                       Cache Storage ne permet ni l'un ni l'autre.
 *   APIs météo          jamais mises en cache ici : core/net.js s'en charge,
 *                       avec l'horodatage nécessaire pour afficher l'âge.
 *
 * Un cache d'API sans âge visible est un piège : l'utilisateur croit lire du
 * frais et prend une décision de mer sur une prévision de la veille.
 * ========================================================================== */

const VERSION = 'v1.9.0';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const VENDOR = 'vendor-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/core/geo.js',
  'js/core/fmt.js',
  'js/core/store.js',
  'js/core/build.js',
  'js/core/idb.js',
  'js/core/net.js',
  'js/data/astro.js',
  'js/data/harmonics.js',
  'js/data/tide.js',
  'js/data/weather.js',
  'js/data/stream.js',
  'js/data/seamarks.js',
  'js/sensors/gps.js',
  'js/sensors/heading.js',
  'js/sensors/motion.js',
  'js/fishing/curves.js',
  'js/fishing/species.js',
  'js/fishing/engine.js',
  'js/fishing/spots.js',
  'js/fishing/advisor.js',
  'js/fishing/learning.js',
  'js/fishing/record.js',
  'js/nav/route.js',
  'js/ui/dom.js',
  'js/ui/widgets.js',
  'js/ui/destination.js',
  'js/ui/sos.js',
  'js/views/nav.js',
  'js/views/pilot.js',
  'js/views/map.js',
  'js/views/horizon.js',
  'js/views/fish.js',
  'js/views/log.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'assets/icon.svg',
  'assets/icon-180.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

const DATA_FILES = ['data/harmonics-dieppe.json', 'data/zones-dieppe.json', 'data/tide-dieppe.json'];

// Leaflet est désormais dans le dépôt : il fait partie de la coque, précaché
// avec elle. Plus de dépendance CDN, donc plus de mode CARTE inutilisable au
// premier lancement hors ligne.
const VENDOR_FILES = [];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      // addAll échoue en bloc si UN fichier manque. On tolère les absences
      // (data/tide-dieppe.json n'existe pas avant le premier refresh) plutôt
      // que de rater toute l'installation pour un 404.
      await Promise.all(SHELL_FILES.map((f) => shell.add(f).catch(() => {})));

      const data = await caches.open(DATA);
      await Promise.all(DATA_FILES.map((f) => data.add(f).catch(() => {})));

      const vendor = await caches.open(VENDOR);
      await Promise.all(
        VENDOR_FILES.map((f) =>
          fetch(f, { mode: 'cors' })
            .then((r) => (r.ok ? vendor.put(f, r) : null))
            .catch(() => {}),
        ),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keep = new Set([SHELL, DATA, VENDOR]);
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Tuiles et APIs : gérées ailleurs, avec leur propre politique de fraîcheur.
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('tiles.openseamap.org') ||
    url.hostname.includes('open-meteo.com') ||
    url.hostname.includes('overpass') ||
    url.hostname.includes('shom.fr')
  ) {
    return;
  }

  if (VENDOR_FILES.some((f) => req.url.startsWith(f.split('?')[0]))) {
    e.respondWith(cacheFirst(req, VENDOR));
    return;
  }

  if (url.pathname.includes('/data/')) {
    e.respondWith(staleWhileRevalidate(req, DATA));
    return;
  }

  if (url.origin === location.origin) {
    e.respondWith(shellStrategy(req));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'hors ligne' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await network) || new Response('null', { headers: { 'Content-Type': 'application/json' } });
}

/**
 * Coque : cache d'abord (démarrage instantané), revalidation silencieuse.
 * En navigation, on retombe sur index.html — l'app est mono-page, une URL
 * profonde ne doit pas produire un 404 hors ligne.
 */
async function shellStrategy(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    fetch(req)
      .then((res) => res.ok && cache.put(req, res.clone()))
      .catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) || (await cache.match('./'));
    }
    return new Response('', { status: 504, statusText: 'hors ligne' });
  }
}

/** Purge déclenchée depuis l'écran Réglages. */
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

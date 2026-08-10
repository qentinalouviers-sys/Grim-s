/* ==========================================================================
 * core/net.js — accès réseau tolérant à la mer
 * --------------------------------------------------------------------------
 * Règle de conception : le réseau est une OPTION, jamais une dépendance.
 *
 * En mer, la panne n'est presque jamais « offline » proprement détecté. C'est
 * une 4G à une barre qui accepte la connexion TCP puis meurt : navigator
 * .onLine dit true, fetch() ne rend jamais la main, et l'app se fige. D'où :
 *
 *   1. timeout dur par AbortController (8 s par défaut) ;
 *   2. réponse mise en cache IndexedDB à chaque succès ;
 *   3. en cas d'échec, on rend le cache avec son âge — jamais une exception ;
 *   4. anti-rafale : une même URL en vol n'est pas redemandée ;
 *   5. backoff mémorisé par hôte, pour ne pas retenter 12 fois d'affilée un
 *      serveur qu'on sait injoignable et vider la batterie.
 * ========================================================================== */

import * as idb from './idb.js';

const inflight = new Map();
const backoff = new Map(); // hôte → { until, tries }

const BACKOFF_BASE = 20_000;
const BACKOFF_MAX = 10 * 60_000;

function hostOf(url) {
  try {
    return new URL(url, location.href).host;
  } catch {
    return url;
  }
}

function penalise(host) {
  const b = backoff.get(host) || { tries: 0 };
  b.tries += 1;
  b.until = Date.now() + Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (b.tries - 1));
  backoff.set(host, b);
}

function absolve(host) {
  backoff.delete(host);
}

function blocked(host) {
  const b = backoff.get(host);
  return b && Date.now() < b.until;
}

/**
 * GET JSON avec cache de repli.
 *
 * @param {string} url
 * @param {{ key?: string, timeoutMs?: number, maxAgeMs?: number, force?: boolean }} opts
 *   key       clé de cache (défaut : l'URL)
 *   maxAgeMs  si le cache est plus frais que ça, on ne touche pas au réseau
 * @returns {Promise<{ data: any, fetchedAt: number, stale: boolean, source: 'network'|'cache'|'none' }>}
 */
export async function getJSON(url, opts = {}) {
  const { key = url, timeoutMs = 8000, maxAgeMs = 0, force = false } = opts;
  const cached = await idb.get('kv', `net:${key}`);

  if (!force && cached && maxAgeMs && Date.now() - cached.fetchedAt < maxAgeMs) {
    return { data: cached.data, fetchedAt: cached.fetchedAt, stale: false, source: 'cache' };
  }

  const host = hostOf(url);
  const offline = !navigator.onLine || blocked(host);

  if (!offline) {
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const fetchedAt = Date.now();
        absolve(host);
        idb.put('kv', `net:${key}`, { data, fetchedAt }); // volontairement non attendu
        return { data, fetchedAt, stale: false, source: 'network' };
      } catch (e) {
        penalise(host);
        console.warn('[net]', host, e?.message || e);
        if (cached) {
          return { data: cached.data, fetchedAt: cached.fetchedAt, stale: true, source: 'cache' };
        }
        return { data: null, fetchedAt: 0, stale: true, source: 'none', error: e };
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  if (cached) {
    return { data: cached.data, fetchedAt: cached.fetchedAt, stale: true, source: 'cache' };
  }
  return { data: null, fetchedAt: 0, stale: true, source: 'none' };
}

/** Lecture d'un fichier statique du dépôt, avec repli cache identique. */
export function getAsset(path, opts = {}) {
  return getJSON(new URL(path, document.baseURI).href, { timeoutMs: 6000, ...opts });
}

/** Purge le backoff — appelé quand l'événement `online` repasse à true. */
export function resetBackoff() {
  backoff.clear();
}

window.addEventListener('online', resetBackoff);

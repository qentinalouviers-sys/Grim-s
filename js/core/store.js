/* ==========================================================================
 * core/store.js — état partagé + bus d'événements
 * --------------------------------------------------------------------------
 * 90 lignes qui remplacent un framework. Un seul objet d'état, des abonnés
 * par clé, un rendu coalescé sur requestAnimationFrame.
 *
 * Pourquoi pas de framework : à bord, chaque kilo-octet est du temps de
 * chargement sur une 3G qui décroche, et un re-render d'arbre virtuel à 1 Hz
 * pendant six heures coûte de la batterie qu'on n'a pas.
 * ========================================================================== */

const listeners = new Map(); // clé → Set<fn>
const anyListeners = new Set();

/** État global. Écrit uniquement via set(). */
export const state = {
  /* Position et cinématique */
  fix: null,          // {lat, lon, accuracy, speedKn, cogDeg, t, alt}
  fixAge: null,
  heading: null,      // {deg, source: 'compass'|'cog', accuracy}
  motion: null,       // {heaveM, periodS, seaState}

  /* Environnement */
  tide: null,         // {series, extrema, source, coefficient, now}
  weather: null,      // {hourly, fetchedAt, stale}
  astro: null,        // {sunrise, sunset, moonPhase, ...}
  stream: null,       // {dir, spd, sense, index}

  /* Pêche */
  samples: [],
  scores: null,
  advice: null,

  /* Navigation */
  nav: null,          // route active : {lat, lon, name, origin, phase, arrivalRadiusM…}
  waypoint: null,     // {lat, lon, name}
  trip: null,         // {startedAt, distanceM, maxSpeedKn}
  anchor: null,       // {lat, lon, radiusM, armed}
  mob: null,

  /* UI */
  view: 'nav',
  online: navigator.onLine,
  nightMode: false,
  settings: null,
  banner: null,
};

/** Abonnement à une ou plusieurs clés. Renvoie la fonction de désabonnement. */
export function subscribe(keys, fn) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
  }
  return () => list.forEach((k) => listeners.get(k)?.delete(fn));
}

/** Abonnement à toute mutation (utilisé par le journal de debug). */
export function subscribeAll(fn) {
  anyListeners.add(fn);
  return () => anyListeners.delete(fn);
}

let pending = new Set();
let frame = 0;

function flush() {
  frame = 0;
  const keys = pending;
  pending = new Set();
  const called = new Set();
  for (const k of keys) {
    const set = listeners.get(k);
    if (!set) continue;
    for (const fn of set) {
      if (called.has(fn)) continue; // un abonné multi-clés ne s'exécute qu'une fois
      called.add(fn);
      try {
        fn(state, keys);
      } catch (e) {
        console.error('[store] abonné en erreur', e);
      }
    }
  }
  for (const fn of anyListeners) fn(state, keys);
}

/**
 * Mutation. Les notifications sont regroupées sur la frame suivante :
 * le GPS, le compas et l'accéléromètre écrivent à des rythmes différents,
 * on ne redessine qu'une fois.
 */
export function set(patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] === v) continue;
    state[k] = v;
    pending.add(k);
    changed = true;
  }
  if (!changed) return;
  if (!frame) frame = requestAnimationFrame(flush);
}

/** Notification forcée (objet muté en place, ex. tableau de track). */
export function touch(...keys) {
  keys.forEach((k) => pending.add(k));
  if (!frame) frame = requestAnimationFrame(flush);
}

/* --------------------------------------------------------------------------
 * Bus d'événements ponctuels (alarmes, actions) — distinct de l'état.
 * ------------------------------------------------------------------------ */
const events = new Map();

export function on(type, fn) {
  if (!events.has(type)) events.set(type, new Set());
  events.get(type).add(fn);
  return () => events.get(type)?.delete(fn);
}

export function emit(type, payload) {
  const set = events.get(type);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[bus] ${type}`, e);
    }
  }
}

window.addEventListener('online', () => set({ online: true }));
window.addEventListener('offline', () => set({ online: false }));

/* ==========================================================================
 * core/sync.js — compte + synchronisation (offline-first)
 * --------------------------------------------------------------------------
 * L'app reste maîtresse de ses données en IndexedDB. Ce module n'est qu'une
 * couche d'échange avec le serveur, à laquelle rien d'autre ne doit dépendre :
 *
 *   - si pas de compte : tout continue à tourner en local, comme avant ;
 *   - si pas de réseau : idem, la synchro attend le prochain retour en ligne ;
 *   - la fusion est par ENREGISTREMENT, last-write-wins sur `updatedAt`.
 *     On ne remplace JAMAIS l'état local par l'état serveur : un journal
 *     rempli hors ligne AVANT la première connexion remonte vers le serveur,
 *     il n'est jamais écrasé par un serveur vide.
 *
 * Deux notions :
 *   collection « records » — liste d'items à identifiant stable (prises,
 *     marques, traces) ; chaque item est une entité synchronisée.
 *   collection « blob » — un seul document par collection (profil, réglages,
 *     espèces libres, relevés de dérive).
 *
 * Les suppressions descendent comme tombstones (deleted=1), jamais comme un
 * effacement aveugle côté serveur : la donnée d'un autre appareil n'est pas
 * détruite par un effacement local.
 * ========================================================================== */

import * as idb from './idb.js';
import { state, set, emit, on } from './store.js';
import * as learning from '../fishing/learning.js';
import * as spots from '../fishing/spots.js';
import * as profile from './profile.js';

/* --- URL de l'API. Surchargable en dev via localStorage.grimsApiBase ------- */
export const API_BASE =
  (typeof localStorage !== 'undefined' && localStorage.getItem('grimsApiBase')) ||
  'https://grims.eviatek.fr';

const FETCH_TIMEOUT = 15000;

/* ==========================================================================
 * Auth
 * ========================================================================== */
let auth = null; // { token, user }

export const isLoggedIn = () => !!auth?.token;
export const currentUser = () => auth?.user || null;
export const authEmail = () => auth?.user?.email || null;

/** Abonnement à la fin d'un tour de synchro (pour l'état affiché). */
export const onDone = (fn) => on('sync:done', fn);

async function api(path, { method = 'GET', body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try { data = await res.json(); } catch { /* réponse vide */ }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.code = data?.error;
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function persistAuth(next) {
  auth = next;
  if (next) await idb.put('kv', 'auth', next);
  else await idb.del('kv', 'auth');
  set({ account: next?.user || null });
  emit('account:changed', next?.user || null);
}

export async function initSync() {
  auth = (await idb.get('kv', 'auth')) || null;
  set({ account: auth?.user || null });

  // Synchro au retour en ligne et à intervalle régulier — jamais bloquante.
  window.addEventListener('online', () => { if (isLoggedIn()) sync().catch(() => {}); });
  setInterval(() => { if (isLoggedIn() && navigator.onLine) sync().catch(() => {}); }, 5 * 60_000);
  return auth;
}

export async function register(email, password, name = null) {
  const r = await api('/api/auth/register', { method: 'POST', body: { email, password, name } });
  await persistAuth(r);
  await sync(); // le compte vient de naître : on monte ce qui existe déjà en local
  return r.user;
}

export async function login(email, password) {
  const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  await persistAuth(r);
  await sync();
  return r.user;
}

export async function logout() {
  await persistAuth(null);
  set({ lastSyncAt: null });
}

/* ==========================================================================
 * Description des collections synchronisées
 * ========================================================================== */
const COLLECTIONS = {
  catches: {
    kind: 'records',
    load: () => idb.all('catches'),
    idOf: (r) => r.id,
    updatedAtOf: (r) => r.t || 0,
    apply: async (id, data, deleted) => {
      if (deleted) await idb.del('catches', id);
      else await idb.put('catches', null, data);
    },
  },
  spots: {
    kind: 'records',
    load: async () => (await idb.get('kv', 'spots')) || [],
    idOf: (r) => r.id,
    updatedAtOf: (r) => r.updatedAt || r.createdAt || 0,
    apply: async (id, data, deleted) => {
      const arr = (await idb.get('kv', 'spots')) || [];
      const next = arr.filter((s) => s.id !== id);
      if (!deleted) next.push(data);
      await idb.put('kv', 'spots', next);
    },
  },
  tracks: {
    kind: 'records',
    load: () => idb.all('tracks'),
    idOf: (r) => r.id,
    updatedAtOf: (r) => r.t || r.startedAt || 0,
    apply: async (id, data, deleted) => {
      if (deleted) await idb.del('tracks', id);
      else await idb.put('tracks', null, data);
    },
  },
  profile: {
    kind: 'blob',
    blobId: 'profile',
    load: async () => (await idb.get('kv', 'profile')) || null,
    updatedAtOf: (r) => r?.updatedAt || 0,
    apply: async (id, data, deleted) => {
      if (deleted) await idb.del('kv', 'profile');
      else {
        await idb.put('kv', 'profile', data);
        set({ profile: data });
      }
    },
  },
  settings: {
    kind: 'blob',
    blobId: 'settings',
    load: async () => (await idb.get('kv', 'settings')) || null,
    updatedAtOf: (r) => r?.updatedAt || 0,
    apply: async (id, data, deleted) => {
      if (deleted) await idb.del('kv', 'settings');
      else {
        await idb.put('kv', 'settings', data);
        set({ settings: data });
      }
    },
  },
  customSpecies: {
    kind: 'blob',
    blobId: 'customSpecies',
    load: async () => (await idb.get('kv', 'customSpecies')) || [],
    updatedAtOf: async () => (await idb.get('kv', 'customSpeciesAt')) || 0,
    apply: async (id, data, deleted) => {
      await idb.put('kv', 'customSpecies', deleted ? [] : data);
    },
  },
  driftObs: {
    kind: 'blob',
    blobId: 'driftObs',
    load: async () => (await idb.get('kv', 'driftObs')) || [],
    updatedAtOf: async () => (await idb.get('kv', 'driftObsAt')) || 0,
    apply: async (id, data, deleted) => {
      await idb.put('kv', 'driftObs', deleted ? [] : data);
    },
  },
};

/* ==========================================================================
 * Horodatage des blobs sans timestamp natif
 * --------------------------------------------------------------------------
 * Les espèces libres et les relevés de dérive sont des listes sans champ
 * updatedAt. Les modules qui les écrivent appellent `stamp()` après mutation ;
 * la synchro lit le marqueur. Un seul point de contact, pas de champ parasite
 * dans les données métier.
 * ========================================================================== */
export async function stamp(collection) {
  await idb.put('kv', `${collection}At`, Date.now());
}

/* ==========================================================================
 * Synchro
 * ========================================================================== */
let syncing = false;

/**
 * Un tour complet : diff local → push, puis pull → merge local.
 * Retourne un résumé pour l'interface (et les tests).
 */
export async function sync() {
  if (!isLoggedIn()) return { ok: false, reason: 'noauth' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, reason: 'offline' };
  if (syncing) return { ok: false, reason: 'busy' };
  syncing = true;
  set({ syncing: true });
  try {
    const snap = (await idb.get('kv', 'sync:snap')) || {};

    /* --- 1. Diff local : ce qui a changé depuis la dernière synchro ------- */
    const changes = [];
    for (const [name, def] of Object.entries(COLLECTIONS)) {
      const cur = await def.load();
      const prev = snap[name] || {};

      if (def.kind === 'records') {
        const now = {};
        for (const r of cur) {
          const id = def.idOf(r);
          const at = def.updatedAtOf(r);
          now[id] = at;
          if (!(id in prev) || at > prev[id]) {
            changes.push({ collection: name, id, updatedAt: at, data: r, deleted: false });
          }
        }
        // Suppression locale → tombstone.
        for (const id of Object.keys(prev)) {
          if (!(id in now)) changes.push({ collection: name, id, updatedAt: Date.now(), data: null, deleted: true });
        }
      } else {
        const at = await def.updatedAtOf(cur);
        const prevAt = prev[def.blobId] ?? 0;
        if (at > prevAt && cur != null) {
          changes.push({ collection: name, id: def.blobId, updatedAt: at, data: cur, deleted: false });
        }
      }
    }

    /* --- 2. Push ---------------------------------------------------------- */
    let pushed = 0;
    if (changes.length) {
      const r = await api('/api/sync/push', { method: 'POST', body: { changes } });
      pushed = r.applied || 0;
    }

    /* --- 3. Pull ---------------------------------------------------------- */
    const meta = (await idb.get('kv', 'sync:meta')) || { lastPullAt: 0 };
    const pr = await api(`/api/sync/pull?since=${meta.lastPullAt || 0}`);
    const pulled = pr.records || [];

    /* --- 4. Merge local : on n'écrase que si le serveur est plus récent --- */
    let appliedPulls = 0;
    for (const rec of pulled) {
      const def = COLLECTIONS[rec.collection];
      if (!def) continue;
      appliedPulls += await mergeRecord(def, rec);
    }

    /* --- 5. Point de reprise --------------------------------------------- */
    const newSnap = await snapshot();
    await idb.put('kv', 'sync:snap', newSnap);
    await idb.put('kv', 'sync:meta', { ...meta, lastPullAt: pr.serverNow, lastSyncAt: Date.now() });

    /* Recalcul dérivé après fusion. */
    await learning.recompute().catch(() => {});
    await spots.reload?.().catch(() => {});
    if (state.profile) { /* le profil d'état est déjà à jour via apply */ }

    set({ syncing: false, lastSyncAt: Date.now() });
    emit('sync:done', { pushed, pulled: appliedPulls });
    return { ok: true, pushed, pulled: appliedPulls };
  } catch (e) {
    set({ syncing: false });
    console.warn('[sync]', e?.message || e);
    return { ok: false, reason: 'error', error: e?.message || String(e) };
  } finally {
    syncing = false;
  }
}

/**
 * Applique un enregistrement serveur en local, uniquement s'il gagne le
 * conflit (updatedAt strictement supérieur). Pour une tombstone, on efface
 * localement seulement si rien de plus récent n'est apparu ici.
 */
async function mergeRecord(def, rec) {
  let localAt = 0;
  if (def.kind === 'records') {
    const cur = await def.load();
    const local = cur.find((r) => def.idOf(r) === rec.id);
    if (local) localAt = def.updatedAtOf(local);
  } else {
    const cur = await def.load();
    localAt = (await def.updatedAtOf(cur)) || 0;
  }

  if (rec.deleted) {
    if (rec.updatedAt > localAt) {
      await def.apply(rec.id, rec.data, true);
      return 1;
    }
    return 0;
  }

  if (rec.updatedAt > localAt) {
    await def.apply(rec.id, rec.data, false);
    return 1;
  }
  return 0;
}

/** Photographie légère de l'état synchronisé : id → updatedAt, sans la donnée. */
async function snapshot() {
  const out = {};
  for (const [name, def] of Object.entries(COLLECTIONS)) {
    const cur = await def.load();
    const map = {};
    if (def.kind === 'records') {
      for (const r of cur) map[def.idOf(r)] = def.updatedAtOf(r);
    } else if (cur != null) {
      map[def.blobId] = await def.updatedAtOf(cur);
    }
    out[name] = map;
  }
  return out;
}

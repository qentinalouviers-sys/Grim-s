/* ==========================================================================
 * core/idb.js — persistance IndexedDB
 * --------------------------------------------------------------------------
 * localStorage est synchrone (il fige le thread pendant qu'on dessine le
 * compas) et plafonne à 5 Mo. On stocke des tuiles raster : IndexedDB est le
 * seul choix. Wrapper minimal, promisifié, quatre magasins.
 *
 *   kv      : réponses API en cache + réglages + calibrations
 *   tiles   : tuiles carte préchargées (Blob), clé "z/x/y@layer"
 *   tracks  : traces enregistrées
 *   catches : journal de captures — le carburant de l'apprentissage local
 *
 * Toute lecture échoue en douceur : à bord, un quota plein ou un mode privé
 * ne doit jamais faire écran noir.
 * ========================================================================== */

const DB_NAME = 'grims-compagnon';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('catches')) {
        const s = db.createObjectStore('catches', { keyPath: 'id' });
        s.createIndex('t', 't');
        s.createIndex('species', 'speciesId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    console.warn('[idb] indisponible, mode mémoire volatile', e);
    return null;
  });
  return dbPromise;
}

const memory = new Map(); // repli si IndexedDB est refusé (Safari navigation privée)

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key) {
  const db = await open();
  if (!db) return memory.get(`${store}:${key}`);
  try {
    return await wrap(tx(db, store, 'readonly').get(key));
  } catch {
    return undefined;
  }
}

export async function put(store, key, value) {
  const db = await open();
  if (!db) {
    memory.set(`${store}:${key}`, value);
    return;
  }
  try {
    const s = tx(db, store, 'readwrite');
    await wrap(s.keyPath ? s.put(value) : s.put(value, key));
  } catch (e) {
    console.warn('[idb] écriture refusée', store, e?.name);
  }
}

export async function del(store, key) {
  const db = await open();
  if (!db) return void memory.delete(`${store}:${key}`);
  try {
    await wrap(tx(db, store, 'readwrite').delete(key));
  } catch {
    /* ignore */
  }
}

export async function all(store) {
  const db = await open();
  if (!db) {
    return [...memory.entries()]
      .filter(([k]) => k.startsWith(`${store}:`))
      .map(([, v]) => v);
  }
  try {
    return (await wrap(tx(db, store, 'readonly').getAll())) || [];
  } catch {
    return [];
  }
}

export async function count(store) {
  const db = await open();
  if (!db) return 0;
  try {
    return await wrap(tx(db, store, 'readonly').count());
  } catch {
    return 0;
  }
}

export async function clear(store) {
  const db = await open();
  if (!db) return;
  try {
    await wrap(tx(db, store, 'readwrite').clear());
  } catch {
    /* ignore */
  }
}

/** Quota disque restant, pour la barre de préchargement des tuiles. */
export async function quota() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota: q } = await navigator.storage.estimate();
    return { usage, quota: q };
  } catch {
    return null;
  }
}

/**
 * Demande la persistance du stockage. Sans ça, iOS purge IndexedDB après
 * 7 jours sans visite — soit exactement le scénario « je n'ai pas ouvert
 * l'app depuis la sortie d'avant et je suis au large sans réseau ».
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

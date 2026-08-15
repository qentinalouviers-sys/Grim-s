/* ==========================================================================
 * core/presence.js — qui est en mer, et où
 * --------------------------------------------------------------------------
 * La flotte : les autres bateaux équipés de Grim's, sur ta carte, avec leur
 * fiche. Deux raisons de faire ça, et elles ne se valent pas.
 *
 *   LA SÉCURITÉ, qui justifie tout le reste. Savoir qu'il y a quelqu'un à
 *   trois milles quand le moteur ne repart pas change complètement la
 *   situation. Un semi-rigide n'a pas d'AIS ; personne ne le voit. C'est
 *   précisément la population que cette couche rend visible.
 *
 *   LA CONVIVIALITÉ, qui est un bonus : voir que trois bateaux du club sont
 *   sortis sur les Ridens.
 *
 * ── CE QUE ÇA COÛTE, ET QUI DÉCIDE ────────────────────────────────────────
 * La position est l'information la plus sensible de l'app. Un bateau immobile
 * deux heures au même point, c'est une marque révélée — même si son
 * propriétaire n'a rien partagé. On ne peut pas prétendre le contraire, et
 * l'app ne le prétend pas : le partage est ÉTEINT tant qu'on ne l'allume pas,
 * le niveau est écrit en clair, et on peut le couper d'un geste depuis la
 * carte sans aller chercher un réglage.
 *
 * Trois niveaux :
 *   off     on voit les autres, personne ne nous voit. C'est l'état de départ.
 *   port    on n'apparaît qu'à moins de 2 milles du port : « il est sorti »,
 *           sans dire où il pêche.
 *   sea     position réelle. C'est ce qui sert à la sécurité, et c'est ce qui
 *           dévoile les postes. Choix assumé, rappelé à l'écran.
 *
 * ── GARDE-FOUS QUI NE SE DÉSACTIVENT PAS ──────────────────────────────────
 *   • rien n'est publié sans compte ni sans position ;
 *   • rien n'est publié à quai (moins de 250 m du port), quel que soit le
 *     niveau — sinon l'app annonce l'adresse du bateau au ponton ;
 *   • le partage s'éteint tout seul après 12 h, pour le téléphone oublié dans
 *     un sac ;
 *   • en cas de MOB ou de SOS, la position part avec le drapeau de détresse
 *     MÊME si le partage est éteint. Une vie vaut plus qu'une marque, et c'est
 *     le seul cas où l'app passe outre le réglage — il est écrit noir sur
 *     blanc dans l'écran de réglage.
 *
 * ── QUAND LE SERVEUR N'EST PAS LÀ ─────────────────────────────────────────
 * Comme la carte des fonds ou les épaves : absent, la fonction n'existe pas.
 * Pas d'onglet vide, pas de message d'erreur en boucle. On tente une fois, et
 * si la route n'existe pas on n'en reparle plus de la session.
 * ========================================================================== */

import { state, set, emit, on } from './store.js';
import * as idb from './idb.js';
import * as sync from './sync.js';
import * as spots from '../fishing/spots.js';
import { distance, bearing } from './geo.js';

export const LEVELS = [
  {
    id: 'off',
    name: 'Invisible',
    short: 'Invisible',
    desc: 'Tu vois les autres, personne ne te voit. Ta position ne quitte pas le téléphone.',
  },
  {
    id: 'port',
    name: 'Au port seulement',
    short: 'Au port',
    desc: 'Tu n’apparais qu’à moins de 2 milles de Dieppe. Le club sait que tu es sorti, personne ne sait où tu pêches.',
  },
  {
    id: 'sea',
    name: 'En mer',
    short: 'En mer',
    desc: 'Position réelle, partout. C’est ce qui sert en cas de pépin — et ce qui montre tes postes à qui regarde.',
  },
];

/* Cadence. 30 s en mouvement, 3 min à l'arrêt : le second cas est aussi celui
 * où l'on pêche, donc celui où l'on tient le moins à être suivi à la trace. */
const PERIOD_MOVING = 30000;
const PERIOD_STILL = 180000;
const PULL_PERIOD = 45000;
const AUTO_OFF_MS = 12 * 3600000;
const QUAY_M = 250;
const PORT_RADIUS_M = 3704;      // 2 milles
const STALE_MS = 15 * 60000;     // au-delà, un bateau n'est plus « en mer »

let cfg = { level: 'off', enabledAt: 0 };
let fleet = [];
let pushTimer = 0;
let pullTimer = 0;
let unavailable = false;   // le serveur ne connaît pas la route : on se tait
let lastPushAt = 0;
let lastPos = null;

export const level = () => cfg.level;
export const isSharing = () => cfg.level !== 'off';
export const boats = () => fleet.slice();
export const serverAvailable = () => !unavailable;

export async function init() {
  cfg = (await idb.get('kv', 'presence')) || { level: 'off', enabledAt: 0 };
  // Extinction automatique : le téléphone oublié allumé dans un sac n'a pas à
  // publier sa position toute la nuit.
  if (cfg.level !== 'off' && cfg.enabledAt && Date.now() - cfg.enabledAt > AUTO_OFF_MS) {
    cfg = { level: 'off', enabledAt: 0 };
    await idb.put('kv', 'presence', cfg);
  }
  schedule();
  on('mob:set', () => pushNow({ distress: 'mob' }));
  on('sos:open', () => pushNow({ distress: 'sos' }));
  return cfg;
}

export async function setLevel(id) {
  if (!LEVELS.some((l) => l.id === id)) return;
  cfg = { level: id, enabledAt: id === 'off' ? 0 : Date.now() };
  await idb.put('kv', 'presence', cfg);
  emit('presence:changed');
  if (id === 'off') await retire();
  else pushNow();
  schedule();
}

/* --------------------------------------------------------------------------
 * Ce qu'on publie, et ce qu'on retient
 * ------------------------------------------------------------------------ */

/**
 * Position à publier selon le niveau, ou null s'il ne faut rien dire.
 * Le drapeau de détresse court-circuite le niveau : c'est le seul cas.
 */
function positionToPublish(distress) {
  const fix = state.fix;
  if (!fix || !Number.isFinite(fix.lat)) return null;
  const port = spots.getPort();
  const dPort = distance(fix, port);

  // À quai, jamais — quel que soit le niveau, et même en détresse : au ponton
  // on appelle les secours de vive voix, et publier l'emplacement exact d'un
  // bateau amarré n'aide personne.
  if (dPort < QUAY_M) return null;
  if (distress) return fix;
  if (cfg.level === 'off') return null;
  if (cfg.level === 'port' && dPort > PORT_RADIUS_M) return null;
  return fix;
}

/** Fiche minimale du bateau. On n'envoie que ce qui sert à l'identifier en mer. */
function boatCard() {
  const p = state.profile || {};
  return {
    boatName: p.boatName || null,
    hull: p.hull || null,
    lengthM: p.lengthM || null,
    propulsion: p.propulsion || null,
    fishing: Array.isArray(p.fishing) ? p.fishing.slice(0, 3) : [],
  };
}

async function pushNow(opts = {}) {
  if (unavailable || !sync.isLoggedIn()) return;
  const pos = positionToPublish(opts.distress);
  if (!pos) return;
  const body = {
    lat: Math.round(pos.lat * 1e5) / 1e5,
    lon: Math.round(pos.lon * 1e5) / 1e5,
    // Cap et vitesse : c'est ce qui permet de savoir si un bateau vient vers
    // toi ou s'en va, donc ce qui rend la couche utile plutôt que décorative.
    sogKn: Number.isFinite(pos.speedKn) ? Math.round(pos.speedKn * 10) / 10 : null,
    cogDeg: Number.isFinite(pos.headingDeg) ? Math.round(pos.headingDeg) : null,
    level: cfg.level,
    distress: opts.distress || null,
    boat: boatCard(),
    at: Date.now(),
  };
  try {
    await sync.apiCall('/api/presence', { method: 'POST', body });
    lastPushAt = Date.now();
    lastPos = pos;
  } catch (e) {
    markIfMissing(e);
  }
}

/** Retire la position du serveur quand on repasse invisible. */
async function retire() {
  if (unavailable || !sync.isLoggedIn()) return;
  try {
    await sync.apiCall('/api/presence', { method: 'DELETE' });
  } catch (e) {
    markIfMissing(e);
  }
  lastPos = null;
}

async function pull() {
  if (unavailable || !sync.isLoggedIn()) return;
  const c = state.fix || spots.getPort();
  // Trente milles : au-delà, ce n'est plus la même sortie.
  const q = `?lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}&radiusNM=30`;
  try {
    const r = await sync.apiCall(`/api/presence${q}`);
    const now = Date.now();
    fleet = (r?.boats || [])
      .filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon))
      .filter((b) => now - (b.at || 0) < STALE_MS)
      .map((b) => ({
        ...b,
        distM: distance(c, b),
        bearingDeg: bearing(c, b),
        ageMs: now - (b.at || now),
      }))
      .sort((a, b) => a.distM - b.distM);
    set({ fleet });
    emit('presence:fleet');
  } catch (e) {
    markIfMissing(e);
  }
}

/**
 * 404 ou 501 : la route n'existe pas sur ce serveur. On arrête d'essayer pour
 * la session au lieu de battre l'API toutes les trente secondes — et l'app
 * n'affiche rien plutôt qu'une fonction morte.
 */
function markIfMissing(e) {
  if (e?.status === 404 || e?.status === 501) {
    unavailable = true;
    stop();
    emit('presence:changed');
  }
}

/* --------------------------------------------------------------------------
 * Cadence
 * ------------------------------------------------------------------------ */
function schedule() {
  stop();
  if (unavailable || !sync.isLoggedIn()) return;
  // On tire la liste même sans partager : voir les autres ne coûte rien à
  // personne, et c'est justement l'intérêt du niveau « Invisible ».
  pull();
  pullTimer = setInterval(pull, PULL_PERIOD);
  if (cfg.level === 'off') return;
  const tick = () => {
    const moving = (state.fix?.speedKn ?? 0) > 0.6;
    const period = moving ? PERIOD_MOVING : PERIOD_STILL;
    if (Date.now() - lastPushAt >= period) pushNow();
  };
  pushTimer = setInterval(tick, PERIOD_MOVING);
  pushNow();
}

export function stop() {
  clearInterval(pushTimer);
  clearInterval(pullTimer);
  pushTimer = 0;
  pullTimer = 0;
}

/** À rappeler après connexion / déconnexion. */
export function refresh() {
  schedule();
}

/** Le bateau le plus proche — la réponse utile en cas de pépin. */
export function nearest() {
  return fleet.find((b) => b.distM > 60) || null;
}

/** Y a-t-il une détresse déclarée dans le secteur ? */
export function distressNearby() {
  return fleet.filter((b) => b.distress);
}

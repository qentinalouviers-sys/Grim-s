/* ==========================================================================
 * core/anchorwatch.js — la veille de mouillage, pour de vrai
 * --------------------------------------------------------------------------
 * On dérape rarement d'un coup. On part en biais, doucement, pendant que tout
 * le monde pêche à l'arrière, et on s'en aperçoit quand la côte n'est plus au
 * même endroit. Une alerte qui ne se déclenche que si l'écran est allumé ET
 * que l'app est au premier plan ne sert donc à rien : c'est exactement le
 * moment où personne ne regarde.
 *
 * ── CE QUE CE MODULE PEUT FAIRE ───────────────────────────────────────────
 *   • garder la veille active quand on change d'écran dans l'app — elle vit
 *     dans le flux GPS, pas dans une vue ;
 *   • la garder au RELANCEMENT de l'app : le point de mouillage est écrit sur
 *     le disque, pas seulement en mémoire ;
 *   • empêcher l'écran de s'éteindre tant qu'elle est armée, pour que le GPS
 *     et le JavaScript continuent de tourner ;
 *   • poser une NOTIFICATION SYSTÈME au dérapage — celle qui s'affiche
 *     par-dessus les autres apps et qui reste dans le tiroir.
 *
 * ── CE QU'IL NE PEUT PAS FAIRE, ET QUI SE DIT ─────────────────────────────
 * Une app web n'a pas le droit de suivre le GPS quand le téléphone est
 * verrouillé et l'app fermée : le navigateur suspend le JavaScript, et aucune
 * astuce ne contourne ça — c'est une règle du système, pas un manque de
 * l'app. Sans serveur pour pousser l'alerte, il n'y a rien à réveiller.
 *
 * D'où le verrou d'écran : tant que la veille est armée, l'écran reste
 * allumé, l'onglet reste vivant, et l'alerte part. L'app le DIT au moment
 * d'armer, au lieu de laisser croire à une surveillance qu'elle n'a pas —
 * une fausse sécurité au mouillage, ça finit sur les cailloux.
 * ========================================================================== */

import { state, set, on, emit } from './store.js';
import * as idb from './idb.js';

const KEY = 'anchor';

let lock = null;
let notified = 0;

/* Deux minutes entre deux notifications système. Le dérapage dure, la
 * position sort du cercle à chaque fixe, et vingt notifications en vingt
 * secondes ne rendent personne plus attentif — elles font éteindre le
 * téléphone. */
const NOTIFY_EVERY = 120_000;

/* ==========================================================================
 * Démarrage
 * ========================================================================== */

/**
 * Restaure une veille armée avant la fermeture de l'app. Le cas est réel :
 * on mouille, on met le téléphone dans la poche, iOS décharge l'onglet, on
 * rouvre — sans ça, la veille était silencieusement perdue.
 */
export async function init() {
  const saved = await idb.get('kv', KEY);
  if (saved?.armed) {
    set({ anchor: saved });
    acquireLock();
  }
  on('alarm', (a) => {
    if (a.kind === 'anchor') notify(a);
  });
  // L'écran peut se rendormir après un appel entrant ou un changement d'onglet :
  // le verrou est repris à chaque retour au premier plan tant qu'on veille.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.anchor?.armed) acquireLock();
  });
  return saved || null;
}

/* ==========================================================================
 * Armer / désarmer
 * ========================================================================== */

/**
 * @param {number} radiusM Rayon de garde. Il ne se devine pas : c'est la
 *   longueur de chaîne mouillée plus la longueur du bateau, plus la marge du
 *   GPS. Cinquante mètres est un défaut prudent pour une ancre de pêche.
 */
export async function arm(radiusM = 50) {
  if (!state.fix) return null;
  const a = {
    lat: state.fix.lat,
    lon: state.fix.lon,
    radiusM,
    armed: true,
    at: Date.now(),
    accuracyM: state.fix.accuracy ?? null,
  };
  set({ anchor: a });
  await idb.put('kv', KEY, a);
  await requestNotifications();
  acquireLock();
  return a;
}

export async function disarm() {
  set({ anchor: null });
  await idb.del('kv', KEY);
  releaseLock();
  notified = 0;
}

/* ==========================================================================
 * Verrou d'écran
 * ========================================================================== */
async function acquireLock() {
  try {
    if (!('wakeLock' in navigator) || lock) return;
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
  } catch { /* refusé ou batterie basse : la veille marche, écran allumé à la main */ }
}

function releaseLock() {
  try { lock?.release(); } catch { /* déjà rendu */ }
  lock = null;
}

/** L'écran est-il tenu allumé ? L'interface le montre, plutôt que de le taire. */
export const holdingScreen = () => !!lock;

/* ==========================================================================
 * Notification système
 * ========================================================================== */

/** Demandée AU MOMENT D'ARMER, jamais au démarrage : une app qui réclame les
 *  notifications avant d'avoir rien à dire se fait refuser une fois pour
 *  toutes, et l'alerte qui compte n'arrivera jamais. */
export async function requestNotifications() {
  try {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return await Notification.requestPermission();
  } catch {
    return 'unsupported';
  }
}

export function notificationState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function notify(a) {
  const now = Date.now();
  if (now - notified < NOTIFY_EVERY) return;
  notified = now;
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const body = `${Math.round(a.distanceM)} m du point de mouillage — rayon de garde ${a.radiusM} m.`;
    /* Par le service worker quand il est là : c'est la seule façon d'obtenir
     * une notification qui survit à la mise en arrière-plan de l'onglet sur
     * Android. Le constructeur direct sert de repli. */
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) {
      await reg.showNotification('⚓ DÉRAPAGE', {
        body,
        tag: 'anchor',
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 120, 300, 120, 600],
        icon: 'assets/icon-180.png',
        badge: 'assets/icon-180.png',
      });
    } else {
      new Notification('⚓ DÉRAPAGE', { body, tag: 'anchor' });
    }
  } catch { /* notification refusée : l'alarme sonore et l'écran restent */ }
}

/* ==========================================================================
 * État lisible par l'interface
 * ========================================================================== */
export function status() {
  const a = state.anchor;
  if (!a?.armed) return { armed: false };
  return {
    armed: true,
    since: a.at,
    radiusM: a.radiusM,
    screenHeld: holdingScreen(),
    notifications: notificationState(),
    lat: a.lat,
    lon: a.lon,
  };
}

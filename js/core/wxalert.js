/* ==========================================================================
 * core/wxalert.js — « préviens-moi quand la mer sera belle »
 * --------------------------------------------------------------------------
 * On ne regarde pas la météo tous les jours. On la regarde le vendredi soir,
 * on voit vingt-cinq nœuds, on renonce — et la fenêtre de six heures qui
 * s'ouvre le mardi matin passe sans que personne la voie. C'est l'inverse du
 * bulletin : ce n'est pas à l'utilisateur d'aller chercher, c'est à l'app de
 * prévenir quand SES conditions à lui sont réunies.
 *
 * ── UNE RÈGLE, C'EST SES CONDITIONS À LUI ─────────────────────────────────
 * Pas un « bon temps » universel. Un pêcheur en 4,50 m ouvert renonce à
 * quinze nœuds ; un autre en 8 m cabine sort à vingt-cinq sans y penser. La
 * règle porte donc des seuils que l'utilisateur pose lui-même, et l'app ne
 * lui dit jamais que ses seuils sont mauvais.
 *
 * ── DEUX MOTEURS POUR LA MÊME RÈGLE, ET C'EST VOULU ───────────────────────
 * LOCAL   ce module évalue la règle contre la prévision déjà téléchargée,
 *         à chaque tour lent. Ça marche AUJOURD'HUI, sans serveur, et ça
 *         prévient par notification système dès que l'app est ouverte une
 *         fois. C'est le filet de sécurité.
 * SERVEUR la même règle part dans la synchro. Un outil côté serveur la relit,
 *         interroge la météo et envoie le mail — c'est le seul moyen d'être
 *         prévenu SANS ouvrir l'app, et c'est le but. Le contrat de cette
 *         route est écrit dans server/wx-alerts.md.
 *
 * Les deux se coordonnent par `notifiedFor` : une fenêtre déjà annoncée ne
 * l'est pas deux fois, quel que soit le moteur qui a parlé.
 *
 * ── CE QUE L'APP NE PEUT PAS FAIRE SEULE, ET QUI SE DIT ───────────────────
 * Envoyer un mail. Aucune app web n'envoie de courrier depuis le téléphone :
 * il faut un serveur, une adresse d'expéditeur et un domaine authentifié.
 * Tant que la route n'existe pas, la règle est enregistrée, synchronisée, et
 * l'alerte locale fonctionne — l'écran le dit en toutes lettres plutôt que de
 * promettre un mail qui ne partirait pas.
 * ========================================================================== */

import * as idb from './idb.js';
import { state, set, emit, on } from './store.js';
import * as sync from './sync.js';

const KEY = 'wxAlerts';

/* Une fenêtre doit durer au moins ça pour valoir un mail. Une éclaircie d'une
 * heure entre deux coups de vent n'est pas une sortie : le temps de descendre
 * au port, de mettre à l'eau et de sortir du chenal, elle est finie. */
export const MIN_WINDOW_H = 2;

/** Modèle d'une règle. Tout est optionnel sauf le vent : c'est le seuil que
 *  personne ne laisse vide, et celui qui décide de tout le reste. */
export const DEFAULT_RULE = {
  id: null,
  name: '',
  windMaxKn: 12,
  gustMaxKn: null,
  waveMaxM: 0.8,
  minHours: 3,
  // Facultatifs, tous « ignoré » par défaut : une règle qui exige du soleil ET
  // pas de pluie ET de l'eau à 17° ne se déclenche jamais, et une alerte qui
  // ne sonne jamais est pire que pas d'alerte.
  needSun: false,
  noRain: false,
  daylightOnly: true,
  seaTempMinC: null,
  days: null,            // null = tous les jours ; sinon [0..6], dimanche = 0
  horizonDays: 7,
  channels: { email: true, push: true },
  placeId: null,         // le port visé ; null = celui de la cabine au moment de l'envoi
  placeName: null,
  lat: null,
  lon: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  notifiedFor: null,     // début de la dernière fenêtre annoncée
};

let rules = [];

/* ==========================================================================
 * Persistance
 * ========================================================================== */
export async function init() {
  rules = (await idb.get('kv', KEY)) || [];
  set({ wxAlerts: rules.length });
  /* La synchro écrit directement dans IndexedDB : sans cette relecture, une
   * alerte réglée sur la tablette serait bien descendue sur le disque mais la
   * liste en mémoire — celle qu'on évalue et qu'on affiche — resterait
   * l'ancienne jusqu'au prochain lancement. */
  on('sync:done', async () => {
    rules = (await idb.get('kv', KEY)) || [];
    set({ wxAlerts: rules.length });
    emit('wxalert:changed', all());
  });
  return rules;
}

export const all = () => rules.map((r) => ({ ...r }));
export const get = (id) => rules.find((r) => r.id === id) || null;
export const enabledCount = () => rules.filter((r) => r.enabled).length;

async function persist() {
  await idb.put('kv', KEY, rules);
  // Horodatage pour la synchro : la liste n'a pas de champ updatedAt propre,
  // c'est le marqueur qui fait foi (même mécanique que les espèces libres).
  await sync.stamp(KEY).catch(() => {});
  set({ wxAlerts: rules.length });
  emit('wxalert:changed', all());
}

export async function save(rule) {
  const now = Date.now();
  const r = { ...DEFAULT_RULE, ...rule, updatedAt: now };
  if (!r.id) {
    r.id = `a${now.toString(36)}${Math.floor(now % 1000)}`;
    r.createdAt = now;
  }
  const i = rules.findIndex((x) => x.id === r.id);
  if (i >= 0) rules[i] = r; else rules.push(r);
  await persist();
  return r;
}

export async function remove(id) {
  rules = rules.filter((r) => r.id !== id);
  await persist();
}

export async function toggle(id, on) {
  const r = get(id);
  if (!r) return null;
  return save({ ...r, enabled: on ?? !r.enabled });
}

/** Remet le compteur à zéro pour qu'une fenêtre déjà annoncée le soit à nouveau. */
export async function forget(id) {
  const r = get(id);
  if (!r) return null;
  return save({ ...r, notifiedFor: null });
}

/* ==========================================================================
 * Évaluation
 * --------------------------------------------------------------------------
 * Une heure PASSE la règle si toutes ses conditions sont tenues. Une FENÊTRE
 * est une suite d'heures qui passent, assez longue pour valoir le déplacement.
 * ========================================================================== */

/** @returns {boolean} */
export function hourPasses(rule, h, sun) {
  if (h == null) return false;
  if (rule.windMaxKn != null && (h.windSpeedKn ?? 0) > rule.windMaxKn) return false;
  if (rule.gustMaxKn != null && (h.windGustKn ?? 0) > rule.gustMaxKn) return false;
  // La mer ABSENTE ne passe pas pour une mer plate : sans donnée marine, on ne
  // sait pas, et « je ne sais pas » ne doit pas déclencher une sortie.
  if (rule.waveMaxM != null) {
    if (h.waveHeightM == null) return false;
    if (h.waveHeightM > rule.waveMaxM) return false;
  }
  if (rule.noRain && (h.precipMm ?? 0) > 0.2) return false;
  if (rule.needSun && (h.cloudPct ?? 100) > 40) return false;
  if (rule.seaTempMinC != null && (h.seaTempC ?? -99) < rule.seaTempMinC) return false;
  if (rule.daylightOnly && sun?.sunriseT && sun?.sunsetT) {
    // Une demi-heure de marge de part et d'autre : on appareille dans le jour
    // naissant, pas au premier rayon.
    if (h.t < sun.sunriseT - 1800000 || h.t > sun.sunsetT + 1800000) return false;
  }
  if (Array.isArray(rule.days) && rule.days.length) {
    if (!rule.days.includes(new Date(h.t).getDay())) return false;
  }
  return true;
}

/**
 * Toutes les fenêtres qui satisfont la règle dans la prévision fournie.
 * @param {Array} hourly Série horaire de data/weather.js.
 * @param {(t:number)=>({sunriseT:number,sunsetT:number})} sunFor Soleil du jour.
 * @returns {{start:number, end:number, hours:number, windMaxKn:number,
 *            waveMaxM:number|null}[]}
 */
export function windows(rule, hourly, sunFor) {
  if (!hourly?.length) return [];
  const now = Date.now();
  const limit = now + (rule.horizonDays || 7) * 86400000;
  const out = [];
  let run = [];

  const flush = () => {
    const minH = Math.max(MIN_WINDOW_H, rule.minHours || MIN_WINDOW_H);
    if (run.length >= minH) {
      const winds = run.map((h) => h.windSpeedKn ?? 0);
      const waves = run.map((h) => h.waveHeightM).filter((v) => typeof v === 'number');
      out.push({
        start: run[0].t,
        // La fin est le BOUT de la dernière heure, pas son début : une fenêtre
        // de 09 h à 11 h dure trois heures, pas deux.
        end: run[run.length - 1].t + 3600000,
        hours: run.length,
        windMaxKn: Math.max(...winds),
        waveMaxM: waves.length ? Math.max(...waves) : null,
      });
    }
    run = [];
  };

  for (const h of hourly) {
    if (h.t < now - 1800000 || h.t > limit) { flush(); continue; }
    if (hourPasses(rule, h, sunFor?.(h.t))) run.push(h);
    else flush();
  }
  flush();
  return out;
}

/**
 * Le tour local. Appelé après chaque chargement de météo.
 *
 * Il ne notifie que la PROCHAINE fenêtre, et une seule fois : sept jours de
 * beau temps produiraient sept notifications identiques, et on désactiverait
 * l'alerte au lieu d'en profiter.
 *
 * @returns {Promise<{rule:object, window:object}[]>} Ce qui a été annoncé.
 */
export async function evaluate({ hourly, sunFor, notify } = {}) {
  const list = hourly || state.weather?.hourly;
  if (!list?.length) return [];
  const fired = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const win = windows(rule, list, sunFor)[0];
    if (!win) continue;
    // Déjà annoncée : on ne repart pas au tour suivant sur la même fenêtre.
    if (rule.notifiedFor && Math.abs(rule.notifiedFor - win.start) < 3600000) continue;
    await save({ ...rule, notifiedFor: win.start });
    fired.push({ rule, window: win });
    try { await notify?.(rule, win); } catch { /* la règle reste marquée : pas de boucle */ }
  }
  if (fired.length) emit('wxalert:fired', fired);
  return fired;
}

/* ==========================================================================
 * Résumé lisible
 * ========================================================================== */

/** La règle, en une phrase. Ce qui est écrit est ce qui est testé. */
export function describe(rule) {
  const p = [`vent ≤ ${Math.round(rule.windMaxKn)} nd`];
  if (rule.gustMaxKn != null) p.push(`rafales ≤ ${Math.round(rule.gustMaxKn)} nd`);
  if (rule.waveMaxM != null) p.push(`mer ≤ ${rule.waveMaxM.toFixed(1)} m`);
  if (rule.needSun) p.push('grand soleil');
  if (rule.noRain) p.push('sans pluie');
  if (rule.seaTempMinC != null) p.push(`eau ≥ ${Math.round(rule.seaTempMinC)}°`);
  const jours = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  if (Array.isArray(rule.days) && rule.days.length && rule.days.length < 7) {
    p.push(rule.days.slice().sort().map((d) => jours[d]).join(' '));
  }
  return `${p.join(' · ')} — ${rule.minHours} h d’affilée${rule.daylightOnly ? ', de jour' : ''}`;
}

/** L'app n'a rien à envoyer par elle-même : l'adresse vient du compte. */
export function targetEmail() {
  return sync.isLoggedIn() ? sync.authEmail() : null;
}

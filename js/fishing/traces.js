/* ==========================================================================
 * fishing/traces.js — les traces de dérive et les touches
 * --------------------------------------------------------------------------
 * Ce qu'un pêcheur veut revoir de sa sortie tient en deux choses : PAR OÙ il
 * est passé, et OÙ ça a mordu. Le reste — la vitesse instantanée, le cap à
 * cette seconde — est du présent, ça ne se garde pas.
 *
 * ── POURQUOI PAS gps.track ────────────────────────────────────────────────
 * La trace du module GPS n'accumule que si une « sortie » est ouverte, et
 * elle est unique : elle mélange le trajet du port au poste et la dérive
 * elle-même. Or c'est exactement la dérive qu'on veut isoler — sa direction,
 * sa longueur, l'endroit où elle a produit une touche — et qu'on veut refaire
 * à l'identique la fois suivante. Une dérive est donc une TRACE À ELLE, qui
 * commence quand on lance le mode pêche et se ferme quand on le quitte.
 *
 * ── POURQUOI UN FICHIER JSON DANS IndexedDB, ET PAS UNE COUCHE DE PLUS ────
 * Ces traces ne valent rien pour un tiers et tout pour celui qui pêche : elles
 * ne partent nulle part, elles ne se synchronisent pas, elles restent sur le
 * téléphone. Et elles s'effacent d'un bouton, toutes ensemble, parce qu'une
 * carte couverte de six mois de dérives ne montre plus rien.
 *
 * ── LE FILTRAGE ───────────────────────────────────────────────────────────
 * Un GPS de téléphone à l'arrêt dessine une pelote de dix mètres de large. On
 * n'enregistre donc un point que s'il s'écarte du précédent de plus que le
 * bruit annoncé par le récepteur. Sans ce filtre, une dérive d'une heure
 * produit trois mille points dont deux mille neuf cents sont du bruit.
 * ========================================================================== */

import * as idb from '../core/idb.js';
import { distance } from '../core/geo.js';
import { emit } from '../core/store.js';

const KEY_TRACES = 'fish-traces';
const KEY_PINGS = 'fish-pings';

/* Une dérive plus vieille que ça n'apprend plus rien sur le poste : les
 * ridins bougent, les épaves s'ensablent, et surtout la marée du jour n'a
 * rien à voir. Six mois, c'est deux saisons — de quoi comparer un printemps
 * à l'autre sans transformer la carte en plat de spaghettis. */
const MAX_AGE_MS = 182 * 24 * 3600 * 1000;
const MAX_TRACES = 60;

let traces = [];   // [{ id, startedAt, endedAt, points: [{lat,lon,t}] }]
let pings = [];    // [{ id, t, lat, lon, kind, note }]
let live = null;   // la trace en cours d'écriture
let dirty = false;

export async function init() {
  traces = (await idb.get('kv', KEY_TRACES)) || [];
  pings = (await idb.get('kv', KEY_PINGS)) || [];
  prune();
}

function prune() {
  const cut = Date.now() - MAX_AGE_MS;
  traces = traces.filter((tr) => (tr.endedAt || tr.startedAt) > cut).slice(-MAX_TRACES);
  pings = pings.filter((p) => p.t > cut);
}

async function persist() {
  if (!dirty) return;
  dirty = false;
  prune();
  await idb.put('kv', KEY_TRACES, traces);
  await idb.put('kv', KEY_PINGS, pings);
}

/* ==========================================================================
 * Traces
 * ========================================================================== */

/** Ouvre une trace. Elle apparaît immédiatement dans `all()`, vide. */
export function begin(t = Date.now()) {
  live = { id: `d${t.toString(36)}`, startedAt: t, endedAt: null, points: [] };
  traces.push(live);
  dirty = true;
  emit('traces:changed');
  return live;
}

/**
 * Ajoute un point si le bateau a bougé plus que le bruit du récepteur.
 * @returns {boolean} vrai si le point a été retenu — le calque ne se
 *   redessine que dans ce cas, ce qui évite un redessin par seconde à l'ancre.
 */
export function push(fix) {
  if (!live || !fix || !Number.isFinite(fix.lat)) return false;
  const last = live.points.at(-1);
  if (last) {
    const noise = Math.max(6, (fix.accuracy || 20) * 0.6);
    if (distance(last, { lat: fix.lat, lon: fix.lon }) < noise) return false;
  }
  live.points.push({ lat: fix.lat, lon: fix.lon, t: fix.t || Date.now() });
  dirty = true;
  return true;
}

/** Ferme la trace. Une dérive d'un seul point n'est pas une dérive. */
export async function end() {
  if (!live) return;
  live.endedAt = Date.now();
  if (live.points.length < 2) traces = traces.filter((tr) => tr !== live);
  live = null;
  dirty = true;
  await persist();
  emit('traces:changed');
}

export const all = () => traces;
export const current = () => live;

/** Longueur de la dérive en cours, en mètres. */
export function liveLengthM() {
  if (!live || live.points.length < 2) return 0;
  let m = 0;
  for (let i = 1; i < live.points.length; i++) m += distance(live.points[i - 1], live.points[i]);
  return m;
}

/* ==========================================================================
 * Touches
 * ========================================================================== */

/**
 * « Le poisson est par là. » Une touche ratée, un banc vu au sondeur, un
 * décrochage : ça ne rentre pas au journal des prises — il n'y a pas de
 * poisson — mais ça vaut de l'or sur la carte à la sortie suivante.
 */
export function ping({ lat, lon, kind = 'touche', note = '' }) {
  if (!Number.isFinite(lat)) return null;
  const p = { id: `t${Date.now().toString(36)}`, t: Date.now(), lat, lon, kind, note };
  pings.push(p);
  dirty = true;
  persist();
  emit('traces:changed');
  return p;
}

export const allPings = () => pings;

/** Annule la dernière touche — le doigt ripe, ça arrive, et sur l'eau. */
export function undoPing() {
  const p = pings.pop();
  if (!p) return null;
  dirty = true;
  persist();
  emit('traces:changed');
  return p;
}

/* ==========================================================================
 * Effacement
 * ========================================================================== */

/** Tout, d'un coup. Une carte couverte de six mois de dérives ne montre rien. */
export async function clearTraces() {
  traces = [];
  live = null;
  dirty = true;
  await persist();
  emit('traces:changed');
}

export async function clearPings() {
  pings = [];
  dirty = true;
  await persist();
  emit('traces:changed');
}

export function stats() {
  return {
    traces: traces.length,
    points: traces.reduce((a, tr) => a + tr.points.length, 0),
    pings: pings.length,
  };
}

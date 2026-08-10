/* ==========================================================================
 * fishing/spots.js — secteurs types et carnet de marques personnel
 * --------------------------------------------------------------------------
 * Deux sources, volontairement séparées :
 *
 *   SEED   data/zones-dieppe.json — des ARCHÉTYPES d'habitat positionnés
 *          approximativement. Ils portent le savoir de zone (quel fond, quelle
 *          profondeur, quelle exposition, quelle logique) mais PAS une marque
 *          au GPS. L'app les affiche en pointillés avec la mention « à recaler ».
 *
 *   PERSO  les marques de l'utilisateur, en IndexedDB. Prioritaires partout.
 *          C'est le vrai carnet : relevé au sondeur, enrichi à chaque sortie
 *          par le journal de captures.
 *
 * Prétendre livrer des points de pêche relevés qu'on n'a pas relevés serait
 * la pire chose à faire dans une app de mer : quelqu'un irait s'y mettre.
 *
 * ── SCORING D'UN POSTE ────────────────────────────────────────────────────
 * Un poste n'est pas bon dans l'absolu : il est bon POUR UNE ESPÈCE, À UNE
 * HEURE, DANS CES CONDITIONS. On croise quatre choses :
 *   habitat        le fond correspond-il à l'espèce ?
 *   profondeur     la gamme de sonde est-elle la bonne ?
 *   dérive locale  le courant sur CE point est-il dans la plage confortable ?
 *   tenue          le vent et la mer permettent-ils d'y rester ?
 * plus un malus de route (le meilleur poste à 14 milles au portant dans 25
 * nœuds n'est pas le meilleur poste).
 * ========================================================================== */

import * as idb from '../core/idb.js';
import * as net from '../core/net.js';
import * as streamModel from '../data/stream.js';
import * as tide from '../data/tide.js';
import { distance, bearing, angleDiff, norm360 } from '../core/geo.js';
import { SPECIES_RULES } from './species.js';
import { plateau, clamp01, ramp } from './curves.js';

let seed = [];
let port = { name: 'Dieppe', lat: 49.9319, lon: 1.0847, coastNormalDeg: 340 };
let personal = [];

export const getPort = () => port;

export async function init() {
  const res = await net.getAsset('data/zones-dieppe.json', { key: 'zones', maxAgeMs: 12 * 3600000 });
  if (res.data) {
    seed = (res.data.zones || []).map((z) => ({ ...z, seed: true, source: 'seed' }));
    if (res.data.port) port = { ...port, ...res.data.port };
    if (res.data.streamNodes) streamModel.setStreamNodes(res.data.streamNodes);
  }
  personal = (await idb.get('kv', 'spots')) || [];
  return { seed: seed.length, personal: personal.length };
}

export const all = () => [...personal, ...seed];
export const personalSpots = () => [...personal];

export async function addSpot(spot) {
  const s = {
    id: `p${Date.now().toString(36)}`,
    createdAt: Date.now(),
    source: 'personal',
    seed: false,
    radiusM: 150,
    habitat: [],
    depthM: null,
    note: '',
    ...spot,
  };
  personal.unshift(s);
  await idb.put('kv', 'spots', personal);
  return s;
}

export async function updateSpot(id, patch) {
  const i = personal.findIndex((s) => s.id === id);
  if (i < 0) return null;
  personal[i] = { ...personal[i], ...patch };
  await idb.put('kv', 'spots', personal);
  return personal[i];
}

export async function removeSpot(id) {
  personal = personal.filter((s) => s.id !== id);
  await idb.put('kv', 'spots', personal);
}

export const find = (id) => all().find((s) => s.id === id) || null;

/* --------------------------------------------------------------------------
 * Exposition
 * ------------------------------------------------------------------------ */

/**
 * Abri 0..1. Deux mécanismes :
 *   • le secteur `exposedFrom` déclaré sur le poste ;
 *   • le fetch géométrique : un vent de terre a peu de fetch près de la côte,
 *     donc peu de mer levée. À Dieppe la côte fait face au 340° : un vent de
 *     sud lève très peu à un mille du bord, et beaucoup à dix milles.
 */
export function shelter(spot, windDirDeg, windSpeedKn = 12) {
  if (!Number.isFinite(windDirDeg)) return 1;
  const offshoreM = distance(spot, port);

  // Vent venant de la terre (secteur opposé à la normale à la côte).
  const offCoast = Math.abs(angleDiff(windDirDeg, norm360(port.coastNormalDeg + 180)));
  const landWind = clamp01(1 - offCoast / 90); // 1 = plein vent de terre
  const fetchRelief = landWind * (1 - clamp01(offshoreM / 18520)); // s'annule à 10 NM

  let sectorPenalty = 0;
  if (Array.isArray(spot.exposedFrom) && spot.exposedFrom.length === 2) {
    const [a, b] = spot.exposedFrom;
    const inSector = a <= b
      ? windDirDeg >= a && windDirDeg <= b
      : windDirDeg >= a || windDirDeg <= b;
    if (inSector) sectorPenalty = clamp01((windSpeedKn - 8) / 18);
  }
  return clamp01(0.35 + 0.65 * (1 - sectorPenalty) + 0.25 * fetchRelief);
}

/**
 * Vent contre courant — le vrai critère de mer formée en Manche.
 * 20 nœuds dans le sens du courant, c'est roulant. 20 nœuds contre 2,5 nœuds
 * de jusant, c'est une mer courte et cassante à 1,5 m qui rend le secteur
 * impraticable. Aucun modèle de houle global ne le voit : la maille est trop
 * grosse. Ici on le calcule.
 * @returns {{ opposed:boolean, severity:number, label:string }}
 */
export function windAgainstTide(windDirDeg, windSpeedKn, streamDirDeg, streamKn) {
  if (![windDirDeg, windSpeedKn, streamDirDeg, streamKn].every(Number.isFinite)) {
    return { opposed: false, severity: 0, label: '' };
  }
  const windToward = norm360(windDirDeg + 180);
  const opposition = Math.abs(angleDiff(windToward, streamDirDeg)); // 180 = pleine opposition
  const alignment = clamp01((opposition - 90) / 90);
  const severity = clamp01(alignment * (windSpeedKn / 22) * (streamKn / 1.8));
  return {
    opposed: severity > 0.25,
    severity,
    label:
      severity > 0.7 ? 'Vent contre courant — mer cassante, à éviter'
      : severity > 0.45 ? 'Vent contre courant marqué — mer courte'
      : severity > 0.25 ? 'Léger vent contre courant' : '',
  };
}

/* --------------------------------------------------------------------------
 * Scoring
 * ------------------------------------------------------------------------ */

/**
 * @returns {{spot, score:number, parts:object, reasons:string[]}}
 */
export function scoreSpot(spot, speciesId, t, wx, fromPos = null) {
  const rule = SPECIES_RULES[speciesId];
  const reasons = [];

  // 1. Habitat
  const spotHab = spot.habitat || [];
  const overlap = spotHab.filter((h) => rule.habitat.includes(h)).length;
  const habitat = spotHab.length === 0 ? 0.5 : clamp01(overlap / Math.min(2, rule.habitat.length));
  if (overlap) reasons.push(`fond ${spotHab.filter((h) => rule.habitat.includes(h)).join(', ')}`);

  // 2. Profondeur — sonde carte + marée = hauteur d'eau réelle
  let depth = 0.6;
  if (Array.isArray(spot.depthM)) {
    const h = tide.height(t);
    const mid = (spot.depthM[0] + spot.depthM[1]) / 2 + h;
    depth = plateau(mid, rule.depthRangeM[0], rule.depthRangeM[1], 6);
  }

  // 3. Dérive locale sur ce point précis
  const drift = streamModel.driftVector(t, spot, wx);
  const [lo, hi] = rule.comfortableDriftKn;
  const driftScore = plateau(drift.spd, lo, hi, 0.5);
  if (driftScore > 0.75) reasons.push(`dérive ${drift.spd.toFixed(1)} nd dans la plage`);
  else if (drift.spd > hi) reasons.push(`dérive trop forte (${drift.spd.toFixed(1)} nd)`);
  else if (drift.spd < lo) reasons.push(`pas assez de courant (${drift.spd.toFixed(1)} nd)`);

  // 4. Tenue de poste
  const shelterScore = shelter(spot, wx?.windDirDeg, wx?.windSpeedKn);
  const wat = windAgainstTide(wx?.windDirDeg, wx?.windSpeedKn, drift.stream.dir, drift.stream.spd);
  const seaKeeping = clamp01(shelterScore * (1 - 0.8 * wat.severity));
  if (wat.opposed) reasons.push(wat.label.toLowerCase());

  // 5. Route
  let access = 1;
  let distanceM = null;
  if (fromPos) {
    distanceM = distance(fromPos, spot);
    // Neutre jusqu'à 6 NM, décroît ensuite ; on ne l'annule jamais totalement.
    access = 0.45 + 0.55 * (1 - ramp(distanceM, 11000, 33000));
  }

  const parts = { habitat, depth, drift: driftScore, seaKeeping, access };
  const weights = { habitat: 3, depth: 2, drift: 3, seaKeeping: 2, access: 1.2 };
  const total =
    Object.entries(parts).reduce((a, [k, v]) => a + v * weights[k], 0) /
    Object.values(weights).reduce((a, b) => a + b, 0);

  // Un poste de départ (seed) est décoté : il vaut comme piste, pas comme marque.
  const trust = spot.seed ? 0.92 : 1;

  return {
    spot,
    score: Math.round(clamp01(total * trust) * 100),
    parts,
    drift,
    windAgainstTide: wat,
    distanceM,
    bearingDeg: fromPos ? bearing(fromPos, spot) : null,
    reasons,
  };
}

/** Meilleurs postes pour une espèce à un instant. */
export function bestSpots(speciesId, t, wx, fromPos = null, limit = 4) {
  return all()
    .map((s) => scoreSpot(s, speciesId, t, wx, fromPos))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Meilleur couple (espèce, poste) à un instant — la question qu'on se pose vraiment. */
export function bestPairing(scores, t, wx, fromPos, speciesIds) {
  const out = [];
  for (const id of speciesIds) {
    const row = scores[id] || [];
    if (!row.length) continue;
    const s = row.reduce((best, cur) => (Math.abs(cur.t - t) < Math.abs(best.t - t) ? cur : best));
    for (const cand of bestSpots(id, t, wx, fromPos, 2)) {
      out.push({
        speciesId: id,
        speciesScore: s.score,
        spotScore: cand.score,
        combined: Math.round(0.6 * s.score + 0.4 * cand.score),
        ...cand,
      });
    }
  }
  return out.sort((a, b) => b.combined - a.combined);
}

/** Import GPX — récupérer un carnet de marques existant. */
export async function importGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX illisible');
  const wpts = [...doc.getElementsByTagName('wpt')];
  let n = 0;
  for (const w of wpts) {
    const lat = parseFloat(w.getAttribute('lat'));
    const lon = parseFloat(w.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    await addSpot({
      name: w.getElementsByTagName('name')[0]?.textContent?.trim() || `Marque ${++n}`,
      lat,
      lon,
      note: w.getElementsByTagName('desc')[0]?.textContent?.trim() || '',
    });
    n++;
  }
  return n;
}

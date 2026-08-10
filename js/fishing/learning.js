/* ==========================================================================
 * fishing/learning.js — journal de captures et apprentissage local
 * --------------------------------------------------------------------------
 * La partie « intelligente » qui compte vraiment, et la seule qui puisse
 * l'être honnêtement : le modèle livré porte des poids issus de la
 * littérature — des opinions bien rangées. Le seul juge, c'est ce que TOI tu
 * sors, sur TES spots, avec TON bateau.
 *
 * Trois boucles d'apprentissage, activées à des seuils différents parce
 * qu'elles n'ont pas le même appétit en données :
 *
 *   ≥ 8 captures/espèce   biais d'abondance — l'espèce sort-elle plus ou moins
 *                         que le modèle ne l'attend ?
 *   ≥ 20 captures/espèce  poids mensuels — mélange progressif du prior avec la
 *                         distribution observée
 *   ≥ 5 dérives           calibration du modèle de courant (data/stream.js)
 *
 * ── POURQUOI SI PRUDENT ───────────────────────────────────────────────────
 * Avec 3 captures on n'apprend rien, on surajuste. Un apprenant qui bouge sur
 * trois points donne à l'utilisateur l'illusion d'un modèle qui progresse
 * alors qu'il ne fait que suivre le bruit. Les seuils sont là pour ça, et le
 * mélange est progressif (`blend`) plutôt que binaire.
 *
 * ── VIE PRIVÉE ────────────────────────────────────────────────────────────
 * Tout reste sur l'appareil, dans IndexedDB. Aucun compte, aucun serveur,
 * aucune télémétrie. Les marques de pêche, ça ne se met pas dans le cloud.
 * ========================================================================== */

import * as idb from '../core/idb.js';
import { SPECIES_RULES, SPECIES_ORDER } from './species.js';
import { setLearned } from './engine.js';
import * as stream from '../data/stream.js';
import { clamp01 } from './curves.js';

const MIN_FOR_BIAS = 8;
const MIN_FOR_SEASON = 20;
const MIN_FOR_DRIFT = 5;

/* --------------------------------------------------------------------------
 * Journal
 * ------------------------------------------------------------------------ */

/**
 * @param {{speciesId:string, lengthCm?:number, released?:boolean, count?:number,
 *          spotId?:string, lat?:number, lon?:number, note?:string,
 *          snapshot?:object, predictedScore?:number}} entry
 */
export async function logCatch(entry) {
  const rec = {
    id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    t: Date.now(),
    count: 1,
    released: false,
    ...entry,
  };
  await idb.put('catches', null, rec);
  // L'écriture est acquittée immédiatement ; le réapprentissage suit sans
  // faire attendre l'utilisateur, qui a un poisson dans les mains.
  recompute().catch((e) => console.warn('[learning]', e));
  return rec;
}

/** Relevé de dérive moteur coupé — la donnée qui calibre le modèle de courant. */
export async function logDrift(obs) {
  const list = (await idb.get('kv', 'driftObs')) || [];
  list.push({ ...obs, id: Date.now() });
  // On garde 400 relevés : au-delà, on n'apprend plus rien et on paie le disque.
  await idb.put('kv', 'driftObs', list.slice(-400));
  return list.length;
}

export const catches = () => idb.all('catches');
export const driftObservations = async () => (await idb.get('kv', 'driftObs')) || [];
export const removeCatch = (id) => idb.del('catches', id).then(recompute);

/* --------------------------------------------------------------------------
 * Apprentissage
 * ------------------------------------------------------------------------ */

let modelState = { bias: {}, seasons: {}, spots: {}, counts: {}, drift: null };

export const model = () => modelState;

/**
 * Recalcule les ajustements et les injecte dans le moteur de scoring.
 * Appelé après chaque écriture, et au démarrage.
 */
export async function recompute() {
  const list = await idb.all('catches');
  const bias = {};
  const seasons = {};
  const spotStats = {};
  const counts = {};

  const bySpecies = new Map();
  for (const c of list) {
    // Les espèces libres comptent dans les totaux et la productivité des
    // postes, mais pas dans l'apprentissage des poids : elles n'ont pas de
    // règles à réajuster.
    const k = c.spotId || 'hors-marque';
    spotStats[k] = (spotStats[k] || 0) + (c.count || 1);
    if (!SPECIES_RULES[c.speciesId]) continue;
    if (!bySpecies.has(c.speciesId)) bySpecies.set(c.speciesId, []);
    bySpecies.get(c.speciesId).push(c);
  }

  const total = list.reduce((a, c) => a + (c.count || 1), 0);

  for (const id of SPECIES_ORDER) {
    const rows = bySpecies.get(id) || [];
    const n = rows.reduce((a, c) => a + (c.count || 1), 0);
    counts[id] = n;

    /* --- 1. Biais d'abondance ------------------------------------------- *
     * On compare la part réelle de l'espèce dans les prises à la part que le
     * modèle prédisait AU MOMENT de ces sorties (via predictedScore stocké).
     * S'il n'y a pas de score stocké, on ne conclut rien : mieux vaut ne pas
     * apprendre que d'apprendre faux. */
    const withScore = rows.filter((c) => Number.isFinite(c.predictedScore));
    if (n >= MIN_FOR_BIAS && withScore.length >= MIN_FOR_BIAS && total > 0) {
      const observedShare = n / total;
      const expectedShare =
        withScore.reduce((a, c) => a + c.predictedScore, 0) /
        (withScore.length * 100 * SPECIES_ORDER.length);
      if (expectedShare > 0.005) {
        const raw = observedShare / expectedShare;
        // Mélange progressif : plein effet seulement vers 40 captures.
        const confidence = clamp01((n - MIN_FOR_BIAS) / (40 - MIN_FOR_BIAS));
        bias[id] = Number((1 + (Math.min(1.8, Math.max(0.4, raw)) - 1) * confidence * 0.5).toFixed(3));
      }
    }

    /* --- 2. Poids mensuels ---------------------------------------------- */
    if (n >= MIN_FOR_SEASON) {
      const months = new Array(12).fill(0);
      for (const c of rows) months[new Date(c.t).getMonth()] += c.count || 1;
      const max = Math.max(...months);
      if (max > 0) {
        const prior = SPECIES_RULES[id].monthWeights;
        const confidence = clamp01((n - MIN_FOR_SEASON) / 60) * 0.5; // plafonné à 50 %
        // Lissage circulaire : un mois sans sortie ne doit pas creuser un trou.
        const smoothed = months.map((_, i) =>
          (months[(i + 11) % 12] * 0.25 + months[i] * 0.5 + months[(i + 1) % 12] * 0.25) / max,
        );
        seasons[id] = prior.map((p, i) =>
          Number((p * (1 - confidence) + Math.max(0.05, smoothed[i]) * confidence).toFixed(3)),
        );
      }
    }
  }

  /* --- 3. Calibration du courant ---------------------------------------- */
  const obs = await driftObservations();
  let drift = null;
  if (obs.length >= MIN_FOR_DRIFT) {
    drift = stream.calibrate(obs);
    if (drift.calibrated) {
      stream.setConfig(drift);
      await idb.put('kv', 'driftCalibration', drift);
    }
  }

  modelState = { bias, seasons, spots: spotStats, counts, drift, totalCatches: total };
  setLearned(bias);

  // Les poids mensuels appris sont appliqués en place : le moteur lit
  // SPECIES_RULES[id].monthWeights, on le patche plutôt que de dupliquer la
  // table et risquer une divergence entre les deux.
  for (const [id, w] of Object.entries(seasons)) SPECIES_RULES[id].monthWeights = w;

  await idb.put('kv', 'learning', modelState);
  return modelState;
}

/** Restaure l'état appris et la calibration au démarrage. */
export async function init() {
  const saved = await idb.get('kv', 'driftCalibration');
  if (saved?.calibrated) stream.setConfig(saved);
  await recompute();
  return modelState;
}

/**
 * Ce que l'apprentissage a compris, en clair — pour l'écran Journal.
 * Ne jamais afficher un modèle qui « s'améliore » sans dire de combien ni
 * sur quoi : c'est comme ça qu'on fabrique de la fausse confiance.
 */
export function explain() {
  const out = [];
  const m = modelState;

  if (!m.totalCatches) {
    out.push({
      title: 'Aucune capture enregistrée',
      text: "Le modèle tourne sur ses valeurs par défaut. Chaque prise notée le rapproche de tes spots et de ta façon de pêcher.",
    });
    return out;
  }

  out.push({
    title: `${m.totalCatches} prises enregistrées`,
    text: `Réglage saisonnier actif pour ${Object.keys(m.seasons).length} espèce(s), biais d'abondance pour ${Object.keys(m.bias).length}.`,
  });

  for (const [id, b] of Object.entries(m.bias)) {
    const pct = Math.round((b - 1) * 100);
    if (Math.abs(pct) < 4) continue;
    out.push({
      title: SPECIES_RULES[id].name,
      text: pct > 0
        ? `sort ${pct} % plus souvent que le modèle ne l'attendait — score revu à la hausse (${m.counts[id]} prises).`
        : `sort ${-pct} % moins souvent qu'attendu — score revu à la baisse (${m.counts[id]} prises).`,
    });
  }

  if (m.drift?.calibrated) {
    out.push({
      title: 'Modèle de courant calibré',
      text: `${m.drift.observations} dérives relevées · ${m.drift.knPerMPerHour} nd par m/h · axes ${m.drift.floodAxisDeg}°/${m.drift.ebbAxisDeg}° · déphasage étale ${m.drift.slackLagMin > 0 ? '+' : ''}${m.drift.slackLagMin} min · écart résiduel ${m.drift.rmsKn} nd.`,
    });
  } else {
    out.push({
      title: 'Modèle de courant non calibré',
      text: `Enregistre des dérives moteur coupé (bouton ⏱ en mode Carte). À partir de ${MIN_FOR_DRIFT}, la dérive prédite devient celle de ton bateau.`,
    });
  }

  const bestSpots = Object.entries(m.spots).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (bestSpots.length) {
    out.push({
      title: 'Postes les plus productifs',
      text: bestSpots.map(([k, v]) => `${k} (${v})`).join(' · '),
    });
  }
  return out;
}

/** Export complet, pour sauvegarde ou changement de téléphone. */
export async function exportAll() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    catches: await idb.all('catches'),
    spots: (await idb.get('kv', 'spots')) || [],
    driftObs: await driftObservations(),
    calibration: await idb.get('kv', 'driftCalibration'),
  };
}

export async function importAll(payload) {
  if (!payload || payload.version !== 1) throw new Error('Format inconnu');
  for (const c of payload.catches || []) await idb.put('catches', null, c);
  if (payload.spots?.length) await idb.put('kv', 'spots', payload.spots);
  if (payload.driftObs?.length) await idb.put('kv', 'driftObs', payload.driftObs);
  if (payload.calibration) await idb.put('kv', 'driftCalibration', payload.calibration);
  await recompute();
}

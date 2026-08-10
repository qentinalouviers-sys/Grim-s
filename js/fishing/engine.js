/* ==========================================================================
 * fishing/engine.js — construction des échantillons et scoring
 * --------------------------------------------------------------------------
 * Pipeline :
 *
 *   marée + météo + astro + modèle de courant
 *        └→ buildSamples()   → samples[]  (features dérivées)
 *        └→ scoreAll()       → { especeId: scores[] }
 *        └→ findWindows()    → windows[]
 *
 * Rien ici ne touche au DOM : calcul pur, testable, réutilisable dans un
 * worker ou en Node.
 *
 * ── DIFFÉRENCE MAJEURE AVEC LE MODÈLE D'ORIGINE ───────────────────────────
 * `driftKn` ne vient plus d'un indice normalisé multiplié par un rapport de
 * coefficient — une correction appliquée deux fois qui gonflait les vives-eaux
 * d'environ 40 %. Il vient de data/stream.js, qui prédit une dérive
 * DIMENSIONNELLE en nœuds à partir de dh/dt brut, de la position, du vent, et
 * de la calibration GPS du bateau. Pour le lieu jaune, le saint-pierre et le
 * turbot — dont la contrainte n°1 est « dérive sous 2 nœuds » — c'est la
 * différence entre un score décoratif et un score sur lequel on décide.
 * ========================================================================== */

import { clamp01, weightedMean } from './curves.js';
import { SPECIES_RULES, SPECIES_ORDER, seasonWeight, getRegulationStatus } from './species.js';
import * as tide from '../data/tide.js';
import * as stream from '../data/stream.js';
import * as weather from '../data/weather.js';
import { lightPhaseAt } from '../data/astro.js';

const HOUR = 3600000;

/**
 * Transforme l'environnement en échantillons scorables.
 *
 * @param {{ from:number, to:number, stepMinutes?:number, pos:{lat,lon},
 *           hourly?:object[] }} opts
 * @returns {object[]} EnvSample[]
 */
export function buildSamples(opts) {
  const { from, to, stepMinutes = 30, pos, hourly = [] } = opts;
  const step = stepMinutes * 60000;

  const ext = tide.extrema(from - 14 * HOUR, to + 14 * HOUR);
  const hw = ext.filter((e) => e.kind === 'HW');
  const lw = ext.filter((e) => e.kind === 'LW');

  // Amplitude de référence pour normaliser currentIndex : le maximum de |dh/dt|
  // sur la fenêtre. C'est l'indice SANS DIMENSION (0..1) que consomment les
  // facteurs « force du courant ». La dérive en nœuds, elle, reste dimensionnelle.
  let maxRate = 1e-6;
  const rates = [];
  for (let t = from; t <= to; t += step) {
    const r = tide.rate(t);
    rates.push(r);
    maxRate = Math.max(maxRate, Math.abs(r));
  }

  const samples = [];
  let i = 0;
  for (let t = from; t <= to; t += step, i++) {
    const rate = rates[i];
    const wx = hourly.length ? weather.interp(hourly, t) : null;
    const drift = stream.driftVector(t, pos, wx);
    const coefficient = tide.coefficient(t);

    const nearestHW = nearest(hw, t);
    const nearestLW = nearest(lw, t);

    samples.push({
      t,
      coefficient,
      heightM: tide.height(t),
      rateMPerH: rate,
      currentIndex: clamp01(Math.abs(rate) / maxRate),
      tideSense: drift.stream.sense,
      hoursFromHW: nearestHW ? (t - nearestHW.t) / HOUR : 0,
      hoursFromLW: nearestLW ? (t - nearestLW.t) / HOUR : 0,
      hoursToSlack: drift.stream.hoursToSlack,
      lightPhase: lightPhaseAt(t, pos.lat, pos.lon),
      /** Dérive réelle du bateau : courant + fardage. C'est ce qu'on subit. */
      driftKn: drift.spd,
      driftDirDeg: drift.dir,
      streamKn: drift.stream.spd,
      streamDirDeg: drift.stream.dir,
      windSpeedKn: wx?.windSpeedKn ?? null,
      windDirDeg: wx?.windDirDeg ?? null,
      windGustKn: wx?.windGustKn ?? null,
      seaTempC: wx?.seaTempC ?? null,
      waveHeightM: wx?.waveHeightM ?? null,
      wavePeriodS: wx?.wavePeriodS ?? null,
      pressureHpa: wx?.pressureHpa ?? null,
      pressureTrend6hHpa: hourly.length ? weather.pressureTrend6h(hourly, t) : null,
      turbidity: hourly.length ? weather.turbidity(hourly, t, coefficient) : null,
    });
  }
  return samples;
}

function nearest(items, t) {
  if (!items.length) return null;
  return items.reduce((best, it) => (Math.abs(it.t - t) < Math.abs(best.t - t) ? it : best));
}

/* --------------------------------------------------------------------------
 * Scoring
 * ------------------------------------------------------------------------ */

/** Pondérations apprises du journal de captures (voir learning.js). 1 = neutre. */
let learned = {};
export const setLearned = (map) => { learned = map || {}; };
export const getLearned = () => learned;

export function scoreSpecies(speciesId, sample) {
  const rule = SPECIES_RULES[speciesId];
  const entries = rule.factors.map((f) => ({
    key: f.key,
    label: f.label,
    weight: f.weight,
    value: f.score(sample),
  }));

  const { value, coverage } = weightedMean(entries);
  const season = seasonWeight(rule, sample.t);
  const bonus = learned[speciesId] ?? 1;

  const breakdown = entries
    .filter((e) => e.value != null && Number.isFinite(e.value))
    .map((e) => ({ key: e.key, label: e.label, weight: e.weight, value: e.value }));

  // Facteur limitant = celui dont le manque coûte le plus de points.
  const limitingFactor = breakdown.length
    ? breakdown.reduce((worst, f) =>
        (1 - f.value) * f.weight > (1 - worst.value) * worst.weight ? f : worst,
      )
    : null;

  // Facteur porteur = celui qui fait la journée. Sert à dire « pourquoi c'est bon ».
  const drivingFactor = breakdown.length
    ? breakdown.reduce((best, f) => (f.value * f.weight > best.value * best.weight ? f : best))
    : null;

  return {
    speciesId,
    t: sample.t,
    score: Math.round(clamp01(value * season * bonus) * 100),
    seasonWeight: season,
    coverage,
    breakdown,
    limitingFactor,
    drivingFactor,
  };
}

export function scoreAll(samples, species = SPECIES_ORDER) {
  const out = {};
  for (const id of species) out[id] = samples.map((s) => scoreSpecies(id, s));
  return out;
}

/* --------------------------------------------------------------------------
 * Fenêtres
 * ------------------------------------------------------------------------ */

/**
 * Seuil relatif : 75e percentile de la journée, avec un plancher absolu.
 * Sans ça, une belle journée d'août donne une « fenêtre » de 14 h pour le bar
 * et de 24 h pour la dorade — vrai, mais inutile : on veut le MEILLEUR moment,
 * pas la liste des moments acceptables.
 */
function autoThreshold(scores, floor = 45) {
  if (!scores.length) return floor;
  const sorted = scores.map((s) => s.score).sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  return Math.max(floor, p75);
}

export function findWindows(scores, opts = {}) {
  const { minScore = 'auto', minDurationMinutes = 60 } = opts;
  const threshold = minScore === 'auto' ? autoThreshold(scores) : minScore;
  const windows = [];
  let run = [];

  const flush = () => {
    if (!run.length) return;
    const start = run[0];
    const end = run[run.length - 1];
    if (end.t - start.t < minDurationMinutes * 60000) {
      run = [];
      return;
    }
    const peak = run.reduce((a, b) => (b.score > a.score ? b : a));
    windows.push({
      speciesId: start.speciesId,
      startT: start.t,
      endT: end.t,
      peakT: peak.t,
      peakScore: peak.score,
      meanScore: Math.round(run.reduce((acc, s) => acc + s.score, 0) / run.length),
      limitingFactor: peak.limitingFactor,
      drivingFactor: peak.drivingFactor,
    });
    run = [];
  };

  for (const s of scores) {
    if (s.score >= threshold) run.push(s);
    else flush();
  }
  flush();
  return windows.sort((a, b) => b.peakScore - a.peakScore);
}

/**
 * Classement des espèces à un instant donné, réglementation appliquée.
 * Une espèce fermée descend en bas de liste avec son score barré : on la
 * montre quand même, parce que savoir qu'un lieu jaune mordrait à 92 mais
 * qu'il est interdit jusqu'au 30 avril, c'est une information utile.
 */
export function ranking(scores, t, species = SPECIES_ORDER) {
  return species
    .map((id) => {
      const row = scores[id] || [];
      const s = row.reduce(
        (best, cur) => (Math.abs(cur.t - t) < Math.abs(best.t - t) ? cur : best),
        row[0] || { score: 0, t },
      );
      const reg = getRegulationStatus(id, t);
      return {
        id,
        rule: SPECIES_RULES[id],
        score: s.score,
        limitingFactor: s.limitingFactor,
        drivingFactor: s.drivingFactor,
        regulation: reg,
        blocked: reg.mode === 'closed',
        noKill: reg.mode === 'no-kill',
      };
    })
    .sort((a, b) => (a.blocked === b.blocked ? b.score - a.score : a.blocked ? 1 : -1));
}

/** Meilleure fenêtre toutes espèces confondues, hors espèces fermées. */
export function bestWindow(scores, t = Date.now()) {
  let best = null;
  for (const id of Object.keys(scores)) {
    if (getRegulationStatus(id, t).mode === 'closed') continue;
    for (const w of findWindows(scores[id])) {
      if (w.endT < t) continue;
      if (!best || w.peakScore > best.peakScore) best = w;
    }
  }
  return best;
}

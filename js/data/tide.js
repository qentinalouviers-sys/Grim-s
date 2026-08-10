/* ==========================================================================
 * data/tide.js — fournisseur de marée
 * --------------------------------------------------------------------------
 * Trois sources, par ordre de préférence, choisies automatiquement :
 *
 *   1. SHOM      data/tide-dieppe.json, produit par scripts/refresh_tide.py et
 *                rafraîchi par GitHub Actions. Fait autorité tant qu'il couvre
 *                l'instant demandé.
 *   2. HARMONIC  modèle ajusté sur cette même série (data/harmonics-dieppe.json).
 *                Prend le relais dès qu'on sort de la fenêtre SHOM — planifier
 *                une sortie dans trois semaines, ou simplement rouvrir l'app
 *                après dix jours sans réseau.
 *   3. PROVISOIRE le même modèle avant tout ajustement. Utilisable, mais
 *                signalé partout dans l'UI.
 *
 * La bascule est silencieuse pour le calcul et VISIBLE pour l'utilisateur :
 * un bandeau de source est exposé dans l'état. On ne laisse jamais croire à
 * une précision qu'on n'a pas.
 * ========================================================================== */

import * as net from '../core/net.js';
import { TideModel, EMERGENCY_SPEC } from './harmonics.js';

const HOUR = 3600000;

let model = null;
let shom = null; // { series, extrema, fetchedAt, from, to }
let ready = null;

/** Charge constantes harmoniques + série SHOM. Idempotent. */
export function init() {
  if (ready) return ready;
  ready = (async () => {
    const [h, s] = await Promise.all([
      net.getAsset('data/harmonics-dieppe.json', { key: 'harmonics', maxAgeMs: 6 * HOUR }),
      net.getAsset('data/tide-dieppe.json', { key: 'tide-shom', maxAgeMs: 3 * HOUR }),
    ]);

    model = new TideModel(h.data && h.data.constituents ? h.data : EMERGENCY_SPEC);

    // La vignette SHOM publie les PM/BM mais PAS la courbe. Ces extrema sont
    // la donnée officielle qui compte le plus — heures et coefficients — et on
    // les utilise même sans courbe : le modèle harmonique fournit alors la
    // hauteur entre deux extrema, le SHOM fournit les extrema eux-mêmes.
    const series = (s.data?.curve || [])
      .map((p) => ({ t: p.t ?? Date.parse(p.time), heightM: p.h ?? p.heightM }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.heightM))
      .sort((a, b) => a.t - b.t);

    const officialExtrema = (s.data?.extrema || [])
      .map((e) => ({
        t: e.t ?? Date.parse(e.time),
        heightM: e.h ?? e.heightM,
        kind: e.kind,
        coefficient: e.coefficient ?? null,
      }))
      .filter((e) => Number.isFinite(e.t) && Number.isFinite(e.heightM))
      .sort((a, b) => a.t - b.t);

    if (series.length > 10 || officialExtrema.length >= 4) {
      const covering = series.length > 10 ? series : officialExtrema;
      shom = {
        series,
        extrema: officialExtrema,
        fetchedAt: s.fetchedAt,
        from: covering[0].t,
        to: covering[covering.length - 1].t,
        /** true seulement si on a une vraie courbe interpolable. */
        hasCurve: series.length > 10,
      };
      // Contrôle qualité permanent : on mesure ce que vaut le modèle
      // harmonique contre la donnée officielle, et on l'affiche.
      const ref = series.length > 10 ? series.filter((_, i) => i % 6 === 0) : officialExtrema;
      model.rmsM = model.rmsAgainst(ref);
    }
    return true;
  })();
  return ready;
}

/** Hauteur interpolable depuis le SHOM : exige une vraie courbe. */
const inShom = (t) => shom?.hasCurve && t >= shom.from && t <= shom.to;
/** Extrema officiels disponibles sur cet instant. */
const hasOfficialExtrema = (t) => shom && shom.extrema.length > 0 && t >= shom.from - 12 * HOUR && t <= shom.to + 12 * HOUR;

/** Interpolation linéaire dans la série SHOM (pas de 5 min : l'erreur est < 1 cm). */
function shomHeight(t) {
  const s = shom.series;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  if (b.t === a.t) return a.heightM;
  return a.heightM + ((t - a.t) / (b.t - a.t)) * (b.heightM - a.heightM);
}

/** Hauteur d'eau au-dessus du zéro des cartes. */
export function height(t) {
  if (inShom(t)) return shomHeight(t);
  return model ? model.height(t) : 0;
}

/** Vitesse de variation en m/h — moteur du modèle de courant. */
export function rate(t) {
  if (inShom(t)) {
    const d = 600000;
    return ((shomHeight(Math.min(shom.to, t + d)) - shomHeight(Math.max(shom.from, t - d))) / (2 * d)) * HOUR;
  }
  return model ? model.rate(t) : 0;
}

/** Courbe entre deux instants. Recolle SHOM et harmonique sans discontinuité visible. */
export function series(fromT, toT, stepMs = 300000) {
  const out = [];
  for (let t = fromT; t <= toT; t += stepMs) out.push({ t, heightM: height(t) });
  return out;
}

/**
 * Pleines et basses mers sur la fenêtre. Les extrema SHOM (heures officielles,
 * coefficients officiels) priment ; le modèle complète au-delà.
 */
export function extrema(fromT, toT) {
  const modelExt = model ? model.extrema(fromT, toT) : [];
  if (!shom?.extrema?.length) return modelExt;

  const official = shom.extrema.filter((e) => e.t >= fromT && e.t <= toT);

  // L'officiel prime toujours. On écarte donc tout extremum du modèle qui a un
  // homologue officiel du même type à moins de 3 h — dans un sens comme dans
  // l'autre. Une déduplication qui ne regarde que le voisin précédent laisse
  // passer le doublon quand le modèle tombe AVANT l'officiel, et l'app affiche
  // alors deux pleines mers à quelques minutes d'intervalle.
  const NEAR = 3 * HOUR;
  const filler = modelExt.filter(
    (m) => !official.some((o) => o.kind === m.kind && Math.abs(o.t - m.t) < NEAR),
  );

  return [...official, ...filler].sort((a, b) => a.t - b.t);
}

/** Coefficient de marée à l'instant t. */
export function coefficient(t) {
  const ext = extrema(t - 18 * HOUR, t + 18 * HOUR);
  const withCoef = ext.filter((e) => e.coefficient != null);
  if (!withCoef.length) return model ? model.coefficientAt(t, ext) : 70;
  if (withCoef.length === 1) return withCoef[0].coefficient;
  let a = withCoef[0];
  let b = withCoef[withCoef.length - 1];
  for (let i = 0; i < withCoef.length - 1; i++) {
    if (withCoef[i].t <= t && withCoef[i + 1].t >= t) {
      a = withCoef[i];
      b = withCoef[i + 1];
      break;
    }
  }
  const f = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return Math.round(a.coefficient + f * (b.coefficient - a.coefficient));
}

/** Prochaines PM/BM après t. */
export function next(t, n = 4) {
  return extrema(t - HOUR, t + 3 * 24 * HOUR)
    .filter((e) => e.t > t)
    .slice(0, n);
}

/** Marnage de la marée en cours (m) — utile pour l'estimation de courant. */
export function currentRange(t) {
  const ext = extrema(t - 12 * HOUR, t + 12 * HOUR);
  const before = [...ext].reverse().find((e) => e.t <= t);
  const after = ext.find((e) => e.t > t);
  if (!before || !after) return model?.meanSpringRange ?? 8.5;
  return Math.abs(after.heightM - before.heightM);
}

/** Métadonnées de source, pour le bandeau de fiabilité. */
export function info(t = Date.now()) {
  if (inShom(t)) {
    return {
      source: 'SHOM',
      label: 'SHOM',
      detail: `Courbe officielle · maj ${new Date(shom.fetchedAt).toLocaleDateString('fr-FR')}`,
      trust: 'high',
      provisional: false,
    };
  }
  if (hasOfficialExtrema(t)) {
    return {
      source: 'SHOM_EXTREMA',
      label: 'SHOM · PM/BM',
      detail:
        `Heures et coefficients officiels du SHOM ; hauteurs intermédiaires ` +
        `calculées${model?.rmsM != null ? ` (écart ${(model.rmsM * 100).toFixed(0)} cm aux PM/BM)` : ''}. ` +
        `Maj ${new Date(shom.fetchedAt).toLocaleDateString('fr-FR')}.`,
      trust: 'high',
      provisional: false,
    };
  }
  if (model && !model.provisional) {
    return {
      source: 'HARMONIC',
      label: 'Harmonique',
      detail:
        model.rmsM != null
          ? `Modèle 23 constituants · écart ${(model.rmsM * 100).toFixed(0)} cm sur SHOM`
          : 'Modèle 23 constituants ajusté',
      trust: 'good',
      provisional: false,
    };
  }
  return {
    source: 'PROVISIONAL',
    label: 'Provisoire',
    detail: 'Constantes non calées — heures à ±30 min. Reconnecte-toi pour caler le modèle.',
    trust: 'low',
    provisional: true,
  };
}

/** Hauteur d'eau réelle sur une sonde de carte (sonde + marée). */
export const depthOver = (soundingM, t = Date.now()) => soundingM + height(t);

export const getModel = () => model;

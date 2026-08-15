/* ==========================================================================
 * data/wrecks.js — les épaves du secteur, à bord
 * --------------------------------------------------------------------------
 * Lit le fichier produit par scripts/fetch_wrecks.py depuis EMODnet Human
 * Activities (source SHOM et UKHO).
 *
 * ── POURQUOI C'EST LA MEILLEURE DONNÉE DE PÊCHE DE L'APP ─────────────────
 * Les huit secteurs types livrés jusqu'ici sont des ARCHÉTYPES d'habitat que
 * j'ai positionnés approximativement : ils portent une logique — quel fond,
 * quelle profondeur, quelle exposition — mais pas une marque. C'est écrit
 * dans le fichier et affiché en pointillés dans l'app, et ça ne remplace pas
 * un point.
 *
 * Une épave, elle, est un point RÉEL, public et documenté : c'est un obstacle
 * à la navigation, donc l'État le relève et le publie. Et une épave dans
 * 15 à 30 m d'eau en Manche orientale est le poste à bar et à lieu jaune par
 * excellence — du relief dur au milieu du sable, un abri dans le courant, et
 * du fourrage qui tourne autour en permanence.
 *
 * ── CE QUE CE MODULE NE PRÉTEND PAS ───────────────────────────────────────
 * Ce sont des positions HYDROGRAPHIQUES, pas des marques de pêche. Selon
 * l'ancienneté de la levée l'écart peut atteindre plusieurs dizaines de
 * mètres, et certaines entrées sont des obstructions douteuses jamais
 * confirmées. On arrive dessus au sondeur — l'app le dit à chaque fiche.
 *
 * Le fichier est optionnel : absent, tout continue de fonctionner.
 * ========================================================================== */

import { distance, bearing } from '../core/geo.js';

let all = [];
let meta = null;
let loading = null;

export function init() {
  if (all.length || loading) return loading || Promise.resolve(all);
  loading = fetch('data/wrecks-dieppe.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((spec) => {
      if (!spec?.wrecks) return [];
      meta = {
        source: spec.source,
        layer: spec.layer,
        licence: spec.licence,
        fetchedAt: spec.fetchedAt,
        count: spec.count,
      };
      all = spec.wrecks.map((w, i) => ({ ...w, id: `w${i}` }));
      return all;
    })
    .catch(() => [])
    .finally(() => {
      loading = null;
    });
  return loading;
}

export const ready = () => all.length > 0;
export const source = () => meta;
export const list = () => all.slice();

/**
 * Les épaves qui valent une sortie.
 *
 * Sur 189 relevés, une bonne moitié sont des obstructions de chenal, de
 * bassin ou d'estran : de la ferraille sous deux mètres d'eau à trois cents
 * mètres du quai. Ce sont de vraies épaves et ce ne sont pas des postes.
 * On garde ce qui est atteignable, assez creux pour tenir du poisson, et
 * assez loin du port pour ne pas être un morceau de digue.
 */
export function fishable() {
  return all.filter((w) => {
    if (w.distNM < 0.8) return false;
    // Sans sonde annoncée on ne peut pas trancher : on garde, parce qu'une
    // épave non sondée du large reste un poste, et l'app affichera « sonde
    // inconnue » plutôt que d'inventer.
    if (w.depthM == null) return true;
    return w.depthM >= 6 && w.depthM <= 45;
  });
}

/** Les plus proches d'un point, avec distance et relèvement. */
export function nearest(pos, limit = 8, { onlyFishable = true } = {}) {
  if (!pos || !Number.isFinite(pos.lat)) return [];
  const src = onlyFishable ? fishable() : all;
  return src
    .map((w) => ({
      ...w,
      distM: distance(pos, w),
      bearingDeg: bearing(pos, w),
    }))
    .sort((a, b) => a.distM - b.distM)
    .slice(0, limit);
}

/** Nom affichable — la plupart des entrées n'en ont pas, et c'est normal. */
export function label(w) {
  if (w.name) return w.year ? `${w.name} (${w.year})` : w.name;
  return w.depthM != null ? `Épave non identifiée — ${w.depthM} m` : 'Épave non identifiée';
}

/**
 * Sous la forme attendue par le moteur de postes : un point d'habitat « épave »
 * dont la sonde est celle du relevé. Marquées seed, comme les secteurs types :
 * la position vient d'un service hydrographique, pas d'un sondeur de pêche.
 */
let spotCache = null;

export function asSpots() {
  // Le moteur appelle all() une fois par poste et par instant scoré : refaire
  // ce map cent cinquante fois par seconde n'apporte rien, la liste ne bouge
  // qu'au chargement du fichier.
  if (spotCache) return spotCache;
  if (!all.length) return [];
  spotCache = fishable().map((w) => ({
    id: `epave-${w.id}`,
    name: label(w),
    lat: w.lat,
    lon: w.lon,
    habitat: ['epave', 'roche'],
    depthM: w.depthM != null ? [w.depthM, w.depthM] : null,
    seed: true,
    source: 'wreck',
    note: w.depthM != null
      ? `Épave relevée, ${w.depthM} m au-dessus de l’obstacle. Position hydrographique : arrive au sondeur.`
      : 'Épave relevée, sonde non renseignée. Position hydrographique : arrive au sondeur.',
  }));
  return spotCache;
}

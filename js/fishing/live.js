/* ==========================================================================
 * fishing/live.js — le classement du moment, sur les 62 espèces
 * --------------------------------------------------------------------------
 * Le plan de sortie ne raisonnait que sur les sept espèces MODÉLISÉES. C'est
 * la partie sérieuse du moteur — une dizaine de facteurs pondérés par espèce,
 * marée, courant, lumière, température, clarté — mais ça laissait cinquante-
 * cinq espèces du catalogue hors du classement, dont la seiche, le maquereau
 * de bordure ou le congre, qui font des sorties entières.
 *
 * Ce module classe LES SOIXANTE-DEUX. Il ne le fait pas en inventant dix
 * facteurs pour chacune — ça produirait un modèle qui a l'air savant et ne
 * sait rien. Il le fait en séparant honnêtement deux questions différentes :
 *
 *   MODÈLE COMPLET (7 espèces)
 *     « Est-ce que ça mord, à cette heure précise ? »
 *     Marée, courant, lumière, température, clarté, pression. C'est le score
 *     horaire déjà calculé par le moteur.
 *
 *   ESTIMATION (55 espèces)
 *     « Est-ce que l'espèce est là, et le fond lui convient-il ? »
 *     Saison, fond autour de la position, gamme de profondeur, réglementation.
 *     C'est une probabilité de PRÉSENCE, pas de touche.
 *
 * Les deux se classent ensemble parce que c'est ce qu'on veut lire, mais
 * l'app écrit lequel des deux elle affiche, à chaque ligne. Un chiffre de
 * présence qui se ferait passer pour un chiffre de touche serait la pire
 * chose que ce module puisse faire.
 *
 * ── CE QUI EST EXCLU, ET NON DÉCOTÉ ───────────────────────────────────────
 * Une espèce interdite ne descend pas dans le classement : elle en sort. On
 * ne propose pas un poisson qu'on n'a pas le droit de garder, même en bas de
 * liste — sauf en capture-relâcher, où l'app le dit franchement.
 * ========================================================================== */

import { CATALOG, seasonAt, findSpecies } from './catalog.js';
import { SPECIES_RULES, getRegulationStatus } from './species.js';
import * as seabed from '../data/seabed.js';
// `depthData` : `depth` est déjà une variable locale de ce fichier.
import * as depthData from '../data/depth.js';
import { state } from '../core/store.js';
import * as spots from './spots.js';
import * as stream from '../data/stream.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* Poids de la saison. C'est de loin le facteur le mieux établi du lot : une
 * seiche en janvier n'est pas « moins probable », elle est ailleurs. */
const SEASON = { peak: 1, present: 0.55, off: 0.04 };

/* ── Ce qu'on va chercher, et ce qu'on subit ──────────────────────────────
 * Première version de ce module : la PETITE VIVE sortait première du
 * classement, à 99. Elle est de saison, elle vit sur le sable, le modèle avait
 * raison — et le résultat était absurde. Personne ne sort de Dieppe pour aller
 * prendre des vives ; on en décroche, à la pince, en pestant.
 *
 * Un classement de PRÉSENCE n'est pas un classement de PÊCHE. D'où ce facteur,
 * qui vaut 1 par défaut — presque tout ce catalogue se pêche — et qui ne
 * descend que pour ce qu'on ne cible pas :
 *
 *   0.15  ce qu'on préfère ne pas croiser, ou ce qui ne se garde pas
 *   0.45  l'appât et le menu fretin : on en prend, on ne sort pas pour ça
 *
 * C'est un jugement, il est écrit ici plutôt que dilué dans une formule, et il
 * se corrige en une ligne. */
const TARGET = {
  vive: 0.1,               // venimeuse : on la décroche, on ne la cherche pas
  'rascasse-chabot': 0.2,
  cardine: 0.35,
  flet: 0.4,
  lancon: 0.45,            // c'est l'appât du bar, pas le but de la sortie
  sprat: 0.4,
  anchois: 0.4,
  bogue: 0.45,
  sardine: 0.6,
  chinchard: 0.6,
  orphie: 0.6,
  // Grands migrateurs et espèces sous régime spécial : légalement ou
  // pratiquement hors d'une sortie ordinaire au départ de Dieppe.
  'thon-rouge': 0.15,
  'requin-taupe': 0.1,
  saumon: 0.1,
  alose: 0.2,
  anguille: 0.1,
  aiguillat: 0.2,
};

/* Ce qu'on suppose de la mordue quand on n'a pas de modèle horaire.
 *
 * Ni 1 ni 0 : ne rien savoir de la marée, du courant et de la lumière, c'est
 * ignorer plus de la moitié de ce qui décide d'une touche. Une estimation de
 * présence ne peut donc pas atteindre le score d'une espèce modélisée dans une
 * bonne fenêtre — et elle doit dépasser une espèce modélisée dans une mauvaise.
 * C'est exactement ce que fait ce 0,55, et c'est ce qui rend les deux chiffres
 * comparables au lieu de simplement voisins. */
const NEUTRAL_BITE = 0.55;

/**
 * Score d'estimation d'une espèce du catalogue.
 * @returns {{score:number, parts:object, reasons:string[]}}
 */
/* Habitats qui n'existent que PAR le courant. Un ridin est une dune façonnée
 * par la veine, une épave ne concentre le fourrage que quand ça porte. Les
 * espèces qui vivent là travaillent au courant établi ; celles du sable et de
 * la vase se pêchent à l'étale, et deux nœuds de dérive les rendent
 * simplement impêchables. C'est le facteur qui sépare vraiment deux espèces
 * de saison sur le même fond — sans lui, elles sortaient toutes à égalité. */
const CURRENT_HABITATS = ['veine', 'chenal', 'ridin', 'epave', 'tombant', 'banc-de-sable'];
const SLACK_HABITATS = ['sable', 'vase', 'sablo-vaseux', 'sable-coquillier'];

function estimate(sp, { t, habitats, depthM, driftKn }) {
  const reasons = [];

  // 1. Saison
  const season = SEASON[seasonAt(sp, t)];
  if (season === 1) reasons.push('pleine saison');
  else if (season <= 0.05) reasons.push('hors saison');

  // 2. Fond autour de la position. Sans carte des fonds chargée on reste
  //    neutre : une valeur inventée vaudrait moins que pas de valeur.
  let habitat = 0.6;
  if (habitats?.length && sp.habitat?.length) {
    const hit = sp.habitat.filter((h) => habitats.includes(h));
    habitat = hit.length ? clamp01(0.55 + 0.45 * (hit.length / sp.habitat.length)) : 0.28;
    if (hit.length) reasons.push(`fond ${hit.slice(0, 2).join(', ')}`);
  }

  // 3. Profondeur. On compare la gamme de l'espèce à la sonde sous le bateau
  //    quand on la connaît ; sinon à la tranche courante du secteur de Dieppe,
  //    qui va de la plage à la quarantaine de mètres.
  let depth = 0.7;
  if (Array.isArray(sp.depthM)) {
    const [lo, hi] = sp.depthM;
    if (Number.isFinite(depthM)) {
      depth = depthM >= lo && depthM <= hi
        ? 1
        : clamp01(1 - Math.min(Math.abs(depthM - lo), Math.abs(depthM - hi)) / 25);
      if (depth === 1) reasons.push(`${Math.round(depthM)} m dans sa tranche`);
    } else {
      // Chevauchement avec 3–45 m, la tranche atteignable dans la journée.
      const overlap = Math.max(0, Math.min(hi, 45) - Math.max(lo, 3));
      depth = clamp01(0.45 + 0.55 * (overlap / Math.max(1, hi - lo)));
    }
  }

  // 4. Courant. Le seul facteur horaire qu'on puisse affirmer sans modèle
  //    d'espèce : il se lit dans les habitats déjà déclarés.
  let drift = 1;
  if (Number.isFinite(driftKn) && sp.habitat?.length) {
    /* Un poisson n'est pas « de courant » ou « d'étale » : il est quelque part
     * entre les deux, et ses habitats le disent. Le rouget vit sur le sable ET
     * la roche ; la première version, qui exigeait que TOUS les habitats soient
     * du sable, ne le classait nulle part et lui laissait un facteur neutre.
     * On mesure donc un penchant entre -1 (étale franche) et +1 (veine). */
    const n = sp.habitat.length;
    const cur = sp.habitat.filter((h) => CURRENT_HABITATS.includes(h)).length;
    const slk = sp.habitat.filter((h) => SLACK_HABITATS.includes(h)).length;
    const lean = (cur - slk) / n;

    // Deux courbes, et on interpole entre elles selon le penchant.
    const withCurrent = clamp01(0.35 + 0.65 * clamp01((driftKn - 0.3) / 1.2));
    const withSlack = clamp01(1 - 0.75 * clamp01((driftKn - 0.5) / 1.5));
    const w = (lean + 1) / 2;
    drift = clamp01(withSlack * (1 - w) + withCurrent * w);

    /* En tête des raisons, pas à la fin : le courant du moment est l'argument
     * le plus actionnable des quatre. « Pleine saison » ne fait pas changer de
     * poste, « 1,7 nœud, elle aime ça » si. */
    if (lean > 0.2 && driftKn >= 1) reasons.unshift(`${driftKn.toFixed(1)} nd — elle aime ça`);
    else if (lean < -0.2 && driftKn >= 1.4) reasons.unshift(`${driftKn.toFixed(1)} nd — trop pour elle`);
  }

  // Présence seule : « l'espèce est-elle là, le fond lui va-t-il, et le courant
  // du moment lui convient-il ». La mordue est ajoutée par ranking(), qui sait
  // si un modèle horaire existe.
  const presence = clamp01(season * (0.5 + 0.28 * habitat + 0.22 * depth) * drift);
  return { presence, parts: { season, habitat, depth, drift }, reasons };
}

/**
 * Le classement du moment, toutes espèces confondues.
 *
 * @param {object} o
 * @param {number} [o.t]      instant, par défaut maintenant
 * @param {number} [o.limit]  nombre d'entrées renvoyées
 * @returns {{id:string, name:string, emoji:string, color:string,
 *            score:number, modelled:boolean, regulation:object,
 *            reasons:string[], sp:object}[]}
 */
export function ranking({ t = Date.now(), limit = 4 } = {}) {
  const pos = state.fix || spots.getPort();
  const habitats = seabed.ready() ? seabed.habitatsAround(pos.lat, pos.lon, 600) : [];
  const measured = depthData.meters(pos.lat, pos.lon);
  const st = stream.tidalStream(t, pos);
  // tidalStream() renvoie `spd`, pas `speedKn` : la première version lisait
  // un champ inexistant et le facteur courant ne s'appliquait jamais. Trois
  // espèces sortaient à 50 ex æquo, ce qui avait l'air d'une égalité réelle.
  const driftKn = Number.isFinite(st?.spd) ? st.spd : null;
  const scores = state.scores || {};

  const out = [];
  for (const sp of CATALOG) {
    // Interdite : elle sort du classement, elle n'y descend pas.
    if (sp.status === 'forbidden') continue;

    const reg = SPECIES_RULES[sp.id] ? getRegulationStatus(sp.id, t) : null;
    if (reg?.mode === 'closed') continue;

    /* Un seul barème pour tout le monde :
     *
     *     score = présence × mordue × intérêt
     *
     * La présence se calcule pour les soixante-deux. La mordue vient du modèle
     * horaire quand il existe, et vaut NEUTRAL_BITE sinon — ce qui place
     * mécaniquement une estimation entre une bonne et une mauvaise fenêtre
     * modélisée, ce qui est exactement la vérité de ce qu'on sait. */
    const e = estimate(sp, { t, habitats, depthM: measured, driftKn });
    let presence = e.presence;
    let bite = NEUTRAL_BITE;
    let modelled = false;
    let reasons = e.reasons;

    if (sp.scored && scores[sp.id]?.length) {
      const row = scores[sp.id];
      const best = row.reduce((a, c) => (Math.abs(c.t - t) < Math.abs(a.t - t) ? c : a));
      bite = best.score / 100;
      modelled = true;
      // Le score du moteur porte DÉJÀ la saison de l'espèce : la réappliquer
      // ici la compterait deux fois. On ne garde de la présence que la partie
      // que le moteur ignore — le fond sous le bateau.
      presence = clamp01(0.7 + 0.3 * e.parts.habitat);
      reasons = [];
      if (best.drivingFactor) reasons.push(best.drivingFactor.label.toLowerCase());
      if (best.limitingFactor && best.limitingFactor.value < 0.45) {
        reasons.push(`⚠︎ ${best.limitingFactor.label.toLowerCase()}`);
      }
    }

    const score = presence * bite * (TARGET[sp.id] ?? 1);
    if (!Number.isFinite(score)) continue;
    out.push({
      id: sp.id,
      name: sp.name,
      emoji: sp.emoji,
      color: sp.color,
      score: Math.round(score * 100),
      modelled,
      noKill: reg?.mode === 'no-kill' || sp.status === 'restricted',
      reasons: reasons.slice(0, 2),
      sp,
    });
  }

  out.sort((a, b) => b.score - a.score || Number(b.modelled) - Number(a.modelled));
  return out.slice(0, limit);
}

/** Ce qui a servi au classement — pour l'écrire à l'écran plutôt que le cacher. */
export function basis() {
  const pos = state.fix || spots.getPort();
  return {
    positioned: !!state.fix,
    seabed: seabed.ready() ? seabed.habitatsAround(pos.lat, pos.lon, 600) : [],
    depthM: depthData.meters(pos.lat, pos.lon),
    modelledCount: CATALOG.filter((s) => s.scored).length,
    total: CATALOG.filter((s) => s.status !== 'forbidden').length,
  };
}

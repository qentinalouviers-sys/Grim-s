/* ==========================================================================
 * fishing/species.js — règles par espèce et réglementation
 * --------------------------------------------------------------------------
 * Sept espèces de la Manche orientale, secteur CIEM 7d.
 *
 *   score = clamp01( Σ(poids × facteur) / Σ(poids) ) × poidsSaisonnier × 100
 *
 * Deux décisions de conception à connaître avant de toucher aux poids :
 *
 * 1. La saison est un MULTIPLICATEUR, pas un facteur de la moyenne. Sinon un
 *    maquereau en janvier remonte à 55/100 parce que le vent est bon. Là il
 *    tombe à 4.
 *
 * 2. Un facteur qui renvoie null (donnée absente) est retiré de la moyenne au
 *    lieu de compter zéro. Pas de température d'eau → le score reste juste,
 *    il est seulement moins informé. `coverage` dit à quel point il l'est.
 *
 * limitingFactor = argmax de (1 − valeur) × poids. C'est ce qui rend le score
 * ACTIONNABLE : l'app dit POURQUOI c'est mauvais, donc s'il faut décaler de
 * deux heures, changer de spot ou rentrer.
 *
 * ── CE QU'IL NE FAUT PAS CROIRE ───────────────────────────────────────────
 * • Les poids viennent de la littérature halieutique (guides, moniteurs-guides
 *   Manche). Ce sont des opinions bien rangées, pas un modèle validé. La
 *   structure est faite pour être REFITTÉE sur le journal de captures : voir
 *   fishing/learning.js, qui fait exactement ça une fois qu'il y a des données.
 * • La pression atmosphérique est à poids 0,5 et les sources se contredisent
 *   frontalement. Le seul consensus est que la TENDANCE compte plus que la
 *   valeur. Mettre ce poids à 0 est défendable.
 * • Pas de solunaire. La lune agit déjà via le coefficient, qui est en entrée.
 * • REGULATIONS est daté (lastCheckedISO) et périmera. À revérifier chaque
 *   année auprès de la DIRM Manche Est – Mer du Nord.
 * ========================================================================== */

import { plateau, bell, ramp, floorAt } from './curves.js';

/* ==========================================================================
 * 1. RÉGLEMENTATION — ⚠ à revérifier chaque année
 * --------------------------------------------------------------------------
 * Ce bloc n'a pas vocation à faire autorité : il sert à bloquer l'UI, pas à
 * remplacer la consultation de la DIRM MEMN.
 * ========================================================================== */

const ZONE = 'CIEM 7d — Manche Est (Dieppe)';
const REG_YEAR = 2026;
const REG_CHECKED = '2026-08-10';

export const REGULATIONS = {
  bar: {
    minSizeCm: 42,
    dailyBag: 3,
    markingRequired: true,
    declarationRequired: true,
    closedPeriods: [
      {
        from: '02-01',
        to: '03-31',
        mode: 'no-kill',
        note: 'Capture-relâcher uniquement, à la canne ou à la ligne à main.',
      },
    ],
    notes: [
      'Filets fixes interdits pour le bar.',
      'Marquage : ablation de la partie inférieure de la nageoire caudale.',
    ],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
  'lieu-jaune': {
    minSizeCm: 42,
    dailyBag: 2,
    markingRequired: true,
    declarationRequired: true,
    closedPeriods: [
      {
        from: '01-01',
        to: '04-30',
        mode: 'closed',
        note: 'Aucune capture. Le pêcher-relâcher est lui aussi interdit.',
      },
    ],
    notes: [
      "L'arrêté français du 24/12/2024 est plus restrictif que le règlement UE : c'est lui qui s'applique.",
      'Pêcher-relâcher interdit toute l\'année.',
    ],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
  'saint-pierre': {
    markingRequired: false,
    closedPeriods: [],
    notes: ['Pas de taille minimale réglementaire en Manche à date.'],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
  turbot: {
    minSizeCm: 30,
    markingRequired: false,
    closedPeriods: [],
    notes: ['Barbue : même maille pratique, vérifier l\'arrêté en vigueur.'],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
  'raie-bouclee': {
    minSizeCm: 45,
    markingRequired: false,
    closedPeriods: [],
    notes: [
      "Mesure du bout du museau à l'extrémité de la nageoire caudale.",
      'Plusieurs espèces de raies sont interdites à la capture : identifier avant de conserver.',
    ],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
  'dorade-grise': {
    minSizeCm: 23,
    markingRequired: true,
    closedPeriods: [],
    notes: ['Marquage obligatoire.'],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
  maquereau: {
    minSizeCm: 20,
    dailyBag: 10,
    markingRequired: true,
    declarationRequired: true,
    closedPeriods: [],
    notes: [
      'Quota de 10 par jour et par personne, relâchés ou non.',
      'Marquage possible juste avant débarquement.',
    ],
    zone: ZONE, sourceYear: REG_YEAR, lastCheckedISO: REG_CHECKED,
  },
};

export const REGULATION_META = { zone: ZONE, year: REG_YEAR, checked: REG_CHECKED };

const monthDay = (d) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Gère les périodes qui enjambent le 31 décembre (ex. "11-01" → "02-28"). */
const inPeriod = (md, from, to) =>
  from <= to ? md >= from && md <= to : md >= from || md <= to;

export function getRegulationStatus(speciesId, date) {
  const regulation = REGULATIONS[speciesId];
  const md = monthDay(typeof date === 'number' ? new Date(date) : date);
  const hit = regulation.closedPeriods.find((p) => inPeriod(md, p.from, p.to));
  if (!hit) return { mode: 'open', regulation };
  return { mode: hit.mode, period: hit, regulation };
}

/* ==========================================================================
 * 2. FACTEURS RÉUTILISABLES
 * --------------------------------------------------------------------------
 * Pour ajouter une espèce : compléter REGULATIONS, SPECIES_RULES et
 * SPECIES_ORDER. Rien d'autre à toucher, le moteur est générique.
 * Pour recalibrer : les poids et les bornes de plateau sont les seuls
 * curseurs. Ne pas toucher au moteur.
 * ========================================================================== */

const fWind = (bestMax, weight = 1) => ({
  key: 'wind',
  label: 'Vent / confort de dérive',
  weight,
  score: (s) => plateau(s.windSpeedKn, 0, bestMax, 8),
});

const fDrift = (lo, hi, weight) => ({
  key: 'drift',
  label: 'Vitesse de dérive',
  weight,
  score: (s) => plateau(s.driftKn, lo, hi, 0.6),
});

const fCoef = (lo, hi, weight, soft = 12) => ({
  key: 'coefficient',
  label: 'Coefficient de marée',
  weight,
  score: (s) => plateau(s.coefficient, lo, hi, soft),
});

const fLight = (weights, weight) => ({
  key: 'light',
  label: 'Lumière',
  weight,
  score: (s) => weights[s.lightPhase],
});

const fSeaTemp = (lo, hi, weight, soft = 2.5) => ({
  key: 'seaTemp',
  label: "Température de l'eau",
  weight,
  score: (s) => (s.seaTempC == null ? null : plateau(s.seaTempC, lo, hi, soft)),
});

/** Volontairement à poids faible : la littérature se contredit. */
const fPressureStability = (weight = 0.5) => ({
  key: 'pressure',
  label: 'Stabilité barométrique',
  weight,
  score: (s) =>
    s.pressureTrend6hHpa == null ? null : plateau(Math.abs(s.pressureTrend6hHpa), 0, 2, 3),
});

const fSlack = (halfWidthH, floor, weight) => ({
  key: 'slack',
  label: "Proximité de l'étale",
  weight,
  score: (s) => floorAt(bell(s.hoursToSlack, 0, halfWidthH), floor),
});

/**
 * Mer — AJOUT par rapport au modèle d'origine.
 * La hauteur de mer ne change pas l'humeur du poisson, elle change la
 * capacité du pêcheur : au-delà de 1,2 m de clapot court on ne tient plus
 * une verticale, on ne sent plus la touche, on ne pose plus au fond. Un
 * score de 90 dans 2 m de mer est une information inutilisable.
 */
const fSea = (bestMax, weight = 1) => ({
  key: 'sea',
  label: 'État de la mer (tenue de poste)',
  weight,
  score: (s) => (s.waveHeightM == null ? null : plateau(s.waveHeightM, 0, bestMax, 0.6)),
});

/**
 * Turbidité — AJOUT.
 * `pref` = turbidité idéale 0..1. Les chasseurs à vue (lieu, saint-pierre,
 * maquereau) veulent de l'eau claire ; le bar tolère et exploite l'eau
 * brassée ; la raie et le turbot, qui chassent à l'odeur et aux vibrations,
 * s'en moquent (facteur simplement absent de leur liste).
 */
const fClarity = (pref, tolerance, weight) => ({
  key: 'clarity',
  label: "Clarté de l'eau",
  weight,
  score: (s) => (s.turbidity == null ? null : bell(s.turbidity, pref, tolerance)),
});

/* ==========================================================================
 * 3. TABLE DES RÈGLES
 * ========================================================================== */

export const SPECIES_RULES = {
  bar: {
    id: 'bar',
    name: 'Bar',
    scientificName: 'Dicentrarchus labrax',
    emoji: '🐟',
    //             J     F    M    A     M    J    J     A    S  O  N    D
    monthWeights: [0.25, 0.3, 0.4, 0.75, 0.9, 0.9, 0.85, 0.9, 1, 1, 0.9, 0.4],
    comfortableDriftKn: [0.8, 3.0],
    habitat: ['epave', 'ridin', 'roche', 'veine'],
    depthRangeM: [3, 40],
    playbook:
      'Il faut du courant. Épaves, ridins, veines. Fenêtre reine : les 2 dernières heures de descendante et la première de montante.',
    technique: {
      clear: 'Leurre souple shad 12–15 cm, plombée 30–60 g selon dérive. Récupération lente au ras du fond.',
      murky: 'Volume et vibration : shad clair, jig lumineux, ou vif au ballon dans la veine.',
      lures: ['Shad 12–15 cm', 'Jig 40–80 g', 'Leurre de surface au petit jour', 'Vif (lançon, maquereau)'],
    },
    factors: [
      {
        key: 'current',
        label: 'Force du courant',
        weight: 3,
        score: (s) => 0.15 + 0.85 * ramp(s.currentIndex, 0.2, 0.6),
      },
      {
        key: 'tideWindow',
        label: 'Fenêtre autour de la basse mer',
        weight: 2,
        score: (s) => floorAt(bell(s.hoursFromLW, -0.5, 2.5), 0.55),
      },
      fCoef(60, 90, 2),
      fLight({ night: 0.8, twilight: 1, day: 0.5 }, 2),
      fSeaTemp(12, 20, 1, 3),
      fWind(16, 1),
      fSea(1.5, 1),
      fClarity(0.45, 0.75, 0.8),
      fPressureStability(0.5),
    ],
    regulation: REGULATIONS.bar,
  },

  'lieu-jaune': {
    id: 'lieu-jaune',
    name: 'Lieu jaune',
    scientificName: 'Pollachius pollachius',
    emoji: '🐠',
    monthWeights: [1, 1, 1, 0.9, 0.6, 0.5, 0.45, 0.45, 0.8, 0.85, 0.7, 0.8],
    comfortableDriftKn: [0.2, 1.8],
    habitat: ['epave', 'roche', 'tombant'],
    depthRangeM: [15, 55],
    playbook:
      "Épaves > 40 m, têtes de roche, tombants. Il ne lutte pas contre le courant : on l'attaque à l'étale, dérive sous 2 nœuds.",
    technique: {
      clear: 'Verticale sur l\'épave, shad 15 cm sur tête plombée 60–100 g. Décollage franc puis descente contrôlée.',
      murky: 'Rapprocher du fond, jig brillant, animation plus lente.',
      lures: ['Shad 15 cm', 'Madaï / inchiku', 'Jig 60–120 g'],
    },
    factors: [
      fSlack(1.5, 0.1, 3),
      fDrift(0.2, 1.8, 3),
      fCoef(50, 75, 2),
      fLight({ night: 0.7, twilight: 1, day: 0.6 }, 1.5),
      fSeaTemp(7, 14, 1.5, 2),
      fWind(14, 1),
      fSea(1.2, 1.2),
      fClarity(0.2, 0.6, 1),
      fPressureStability(0.5),
    ],
    regulation: REGULATIONS['lieu-jaune'],
  },

  'saint-pierre': {
    id: 'saint-pierre',
    name: 'Saint-Pierre',
    scientificName: 'Zeus faber',
    emoji: '🐡',
    monthWeights: [0.1, 0.1, 0.15, 0.5, 0.8, 0.9, 0.9, 1, 0.85, 0.5, 0.2, 0.1],
    comfortableDriftKn: [0.2, 1.2],
    habitat: ['sable', 'sablo-vaseux', 'roche'],
    depthRangeM: [10, 40],
    playbook:
      "Sable et sablo-vaseux 10–40 m près de la roche, là où il y a du lançon. Très mauvais nageur : verticale lente, dérive lente obligatoire.",
    technique: {
      clear: 'Vif (lançon, petit tacaud) sur montage à un hameçon, ou shad 10 cm animé très lentement au ras du fond.',
      murky: 'Insister près du fond, ralentir encore. Il chasse à vue : eau sale = journée difficile.',
      lures: ['Lançon vif', 'Shad 10 cm', 'Madaï léger'],
    },
    factors: [
      fDrift(0.2, 1.2, 3),
      fLight({ night: 0.4, twilight: 1, day: 0.6 }, 2.5),
      fCoef(30, 70, 1.5),
      fSeaTemp(13, 20, 1.5),
      fWind(12, 1),
      fSea(1.0, 1.2),
      fClarity(0.15, 0.5, 1.5),
    ],
    regulation: REGULATIONS['saint-pierre'],
  },

  turbot: {
    id: 'turbot',
    name: 'Turbot / barbue',
    scientificName: 'Scophthalmus maximus',
    emoji: '🍥',
    monthWeights: [0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6, 0.8, 0.95, 1, 0.9],
    comfortableDriftKn: [0.4, 1.5],
    habitat: ['ridin', 'banc-de-sable', 'sable'],
    depthRangeM: [8, 35],
    playbook:
      'Têtes de ridin et bordures de bancs de sable où vit le lançon. Dérive contrôlée, pas de mouillage. Lançon vif au ras du fond.',
    technique: {
      clear: 'Montage turbot : empile longue, lançon vif ou lanière de maquereau, plombée qui touche le fond à chaque relâché.',
      murky: 'Lanière de seiche, plus odorante. Le turbot chasse à l\'affût, l\'eau sale ne le dérange pas.',
      lures: ['Lançon vif', 'Lanière de maquereau', 'Shad 11 cm rasant'],
    },
    factors: [
      fDrift(0.4, 1.5, 3),
      fSlack(2, 0.5, 2),
      fCoef(25, 65, 2),
      fLight({ night: 0.7, twilight: 1, day: 0.9 }, 1),
      fWind(12, 1.5),
      fSea(1.3, 1.2),
    ],
    regulation: REGULATIONS.turbot,
  },

  'raie-bouclee': {
    id: 'raie-bouclee',
    name: 'Raie bouclée',
    scientificName: 'Raja clavata',
    emoji: '🪁',
    monthWeights: [0.55, 0.5, 0.6, 0.8, 0.9, 0.95, 0.95, 0.95, 0.9, 0.8, 0.7, 0.6],
    comfortableDriftKn: [0.1, 1.2],
    habitat: ['sable', 'vase', 'sable-coquillier'],
    depthRangeM: [5, 30],
    playbook:
      "Sable, vase, sable coquillier. Se rapproche à marée haute et chasse à la tombée de la nuit. Appât gras posé au fond.",
    technique: {
      clear: 'Mouillage, montage à empile courte, appât gras : maquereau, seiche, encornet. Bas de ligne renforcé.',
      murky: 'Identique — la raie travaille au nez. L\'eau sale est même favorable.',
      lures: ['Lanière de maquereau', 'Seiche', 'Encornet'],
    },
    factors: [
      fLight({ night: 1, twilight: 0.85, day: 0.45 }, 3),
      {
        key: 'tideWindow',
        label: 'Fenêtre autour de la pleine mer',
        weight: 2,
        score: (s) => floorAt(bell(s.hoursFromHW, 0, 2.5), 0.5),
      },
      fDrift(0.1, 1.2, 2),
      fCoef(30, 75, 1),
      fWind(14, 1),
      fSea(1.5, 1),
    ],
    regulation: REGULATIONS['raie-bouclee'],
  },

  'dorade-grise': {
    id: 'dorade-grise',
    name: 'Dorade grise',
    scientificName: 'Spondyliosoma cantharus',
    emoji: '🐚',
    monthWeights: [0.2, 0.15, 0.2, 0.4, 0.65, 0.85, 0.95, 1, 1, 0.9, 0.6, 0.35],
    comfortableDriftKn: [0.2, 2.0],
    habitat: ['chenal', 'sable', 'roche', 'epave'],
    depthRangeM: [14, 30],
    playbook:
      "Chenaux et couloirs de sable, 14–30 m. La moins dépendante de la phase de marée : elle mord au flot comme au jusant, on adapte la plombée.",
    technique: {
      clear: 'Montage à deux empiles, ver ou couteau, plombée juste suffisante pour tenir. Ferrage sur la deuxième touche.',
      murky: 'Appât plus odorant (couteau, crabe mou), rester au fond.',
      lures: ['Ver de chalut', 'Couteau', 'Crabe mou', 'Petit jig 30 g'],
    },
    factors: [
      {
        key: 'current',
        label: 'Force du courant',
        weight: 2,
        score: (s) => floorAt(ramp(s.currentIndex, 0.15, 0.5), 0.5),
      },
      fSeaTemp(13, 21, 2),
      fLight({ night: 0.6, twilight: 1, day: 1 }, 1.5),
      fWind(14, 1.5),
      fCoef(30, 95, 1, 15),
      fSea(1.4, 1),
    ],
    regulation: REGULATIONS['dorade-grise'],
  },

  maquereau: {
    id: 'maquereau',
    name: 'Maquereau',
    scientificName: 'Scomber scombrus',
    emoji: '🐋',
    monthWeights: [0.05, 0.05, 0.1, 0.35, 0.8, 1, 1, 0.95, 0.8, 0.45, 0.15, 0.05],
    comfortableDriftKn: [0.2, 2.5],
    habitat: ['pleine-eau', 'chenal', 'ridin'],
    depthRangeM: [5, 40],
    playbook:
      "Pleine eau, chasses repérées aux oiseaux. Les bancs se calent sur les premières heures de marée, quand le courant s'établit.",
    technique: {
      clear: 'Train de plumes, remontée franche dans la couche où ça touche. Repérer les oiseaux avant de mettre à l\'eau.',
      murky: 'Descendre, ralentir, plumes plus voyantes.',
      lures: ['Train de plumes', 'Mitraillette', 'Petit jig 20–40 g'],
    },
    factors: [
      {
        key: 'current',
        label: 'Courant établi',
        weight: 2,
        score: (s) => bell(s.currentIndex, 0.6, 0.55),
      },
      fLight({ night: 0.3, twilight: 1, day: 0.75 }, 2.5),
      fSeaTemp(13, 20, 2.5),
      fWind(13, 1.5),
      fCoef(45, 85, 1),
      fSea(1.2, 1.2),
      fClarity(0.2, 0.6, 0.8),
    ],
    regulation: REGULATIONS.maquereau,
  },
};

export const SPECIES_ORDER = [
  'bar', 'lieu-jaune', 'turbot', 'saint-pierre', 'raie-bouclee', 'dorade-grise', 'maquereau',
];

export const seasonWeight = (rule, t) => rule.monthWeights[new Date(t).getMonth()];

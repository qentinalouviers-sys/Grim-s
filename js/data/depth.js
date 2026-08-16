/* ==========================================================================
 * data/depth.js — la sonde, d'où qu'elle vienne
 * --------------------------------------------------------------------------
 * Deux sources répondent à la même question, et elles ne se valent pas :
 *
 *   CARNET   les sondes relevées au sondeur du bord. Position au GPS du
 *            téléphone, profondeur lue à l'écran, ramenée au zéro des cartes.
 *            Précision métrique là où l'on est passé, rien ailleurs.
 *   GRILLE   le modèle numérique de terrain public, cent mètres de maille.
 *            Couvre tout, ne voit pas le ridin.
 *
 * L'ordre est celui du carnet de marques, et pour la même raison : une mesure
 * qu'on a faite soi-même sur SON bateau bat un modèle interpolé, toujours. Ce
 * module rend donc la sonde du carnet quand il y en a une assez près, la
 * grille sinon, et il DIT LEQUEL — parce que « 14 m » relevé au sondeur et
 * « 14 m » lu dans une maille de cent mètres n'engagent pas au même point.
 *
 * ── POURQUOI UN MODULE ET PAS UN `if` DANS CHAQUE APPELANT ────────────────
 * Ils sont cinq à demander la sonde : le scoring des postes, le conseil en
 * direct, la boîte à leurres, la carte, le journal. Cinq endroits qui doivent
 * décider de la même façon, sous peine qu'un poste soit scoré sur la grille et
 * affiché sur le carnet — avec deux chiffres différents à l'écran pour le même
 * caillou. Une seule règle, écrite une fois.
 * ========================================================================== */

import * as bathy from './bathy.js';
import * as soundings from '../fishing/soundings.js';
import * as tide from './tide.js';

/* Rayon dans lequel une sonde du carnet parle pour le point demandé. Cent
 * cinquante mètres : c'est la longueur d'une dérive courte, donc l'échelle à
 * laquelle un pêcheur considère qu'il est « au même endroit ». Au-delà, sur un
 * fond travaillé, ce n'est plus le même caillou. */
const BOOK_RADIUS_M = 150;

/**
 * La sonde au zéro des cartes.
 *
 * @returns {{
 *   zeroM: number,          profondeur ramenée au zéro des cartes
 *   source: 'carnet'|'grille',
 *   n?: number,             nombre de sondes du carnet retenues
 *   spreadM?: number,       écart entre elles — au-dessus de 2 m, c'est une pente
 *   distanceM?: number,     distance à la sonde la plus proche
 *   resolutionM?: number,   maille du modèle, quand c'est la grille qui parle
 * } | null}
 */
export function at(lat, lon) {
  const book = soundings.depthAt(lat, lon, BOOK_RADIUS_M);
  if (book) return { ...book, source: 'carnet' };

  const grid = bathy.ready() ? bathy.depthAt(lat, lon) : null;
  if (grid == null) return null;
  return {
    zeroM: grid,
    source: 'grille',
    resolutionM: bathy.meta()?.resolutionM ?? null,
  };
}

/** Juste le nombre, pour les appelants qui n'ont que faire de la provenance. */
export const meters = (lat, lon) => at(lat, lon)?.zeroM ?? null;

/**
 * La hauteur d'eau RÉELLE à un instant : la sonde plus la marée. C'est la
 * question qu'on se pose avant de passer, et pas la sonde de carte.
 */
export function water(lat, lon, t = Date.now()) {
  const d = at(lat, lon);
  if (!d) return null;
  return { ...d, waterM: +(d.zeroM + tide.height(t)).toFixed(1), t };
}

/**
 * Le relief autour du point — ce qui fait le poste.
 *
 * Le carnet prime encore, mais il lui faut assez de sondes pour dire quelque
 * chose : trois relevés au même endroit ne décrivent pas un tombant. En
 * dessous, la grille reprend la main même si le carnet a une sonde ; mieux
 * vaut un relief moyenné sur cent mètres qu'un relief inventé sur trois points.
 *
 * La forme rendue est celle de `bathy.relief()` — mêmes champs, même
 * `structure` — pour que les appelants n'aient pas à savoir qui a parlé. Le
 * champ `source` est là pour ceux qui veulent le dire à l'écran.
 */
export function relief(lat, lon, radiusM = 500) {
  const book = soundings.relief(lat, lon, radiusM);
  if (book && book.n >= MIN_BOOK_POINTS) {
    return {
      depthM: book.shallowM,
      minM: book.shallowM,
      maxM: book.deepM,
      reliefM: book.reliefM,
      slopePer100M: null,        // le carnet n'échantillonne pas régulièrement
      samples: book.n,
      resolutionM: null,         // métrique, mais seulement là où l'on est passé
      crest: book.crest,
      structure: classifyBook(book.reliefM, book.n),
      source: 'carnet',
    };
  }

  const grid = bathy.ready() ? bathy.relief(lat, lon, radiusM) : null;
  if (grid) return { ...grid, source: 'grille' };
  return null;
}

/* Cinq sondes : en dessous, l'écart max-min est du bruit de GPS et de lecture
 * autant que du relief. C'est peu, mais c'est atteignable en une dérive. */
const MIN_BOOK_POINTS = 5;

/**
 * Nommer ce que le CARNET voit, et les seuils ne sont pas ceux de la grille.
 *
 * La grille moyenne sur cent mètres : il lui faut six à huit mètres d'écart au
 * kilomètre pour signaler un accident. Le carnet mesure le point exact — deux
 * mètres d'écart sur trois cents mètres, c'est un ridin franc, et c'est
 * précisément ce qu'on cherche et que la grille ne voit pas.
 */
function classifyBook(reliefM, n) {
  if (reliefM >= 6) {
    return {
      id: 'tombant',
      label: 'Cassure relevée au sondeur',
      note: 'Tes propres sondes décrivent une marche nette. Le courant décolle dessus : présente le leurre au bord amont.',
    };
  }
  if (reliefM >= 2) {
    return {
      id: 'ridin',
      label: 'Ridin relevé au sondeur',
      note: `Relief franc mesuré sur ${n} sondes. C'est le poste — passe sur le flanc qui prend le courant, pas sur le sommet.`,
    };
  }
  if (reliefM >= 0.8) {
    return {
      id: 'ondule',
      label: 'Fond légèrement travaillé',
      note: 'Ondulations douces. À sonder davantage : le ridin est peut-être à côté de la trace.',
    };
  }
  return {
    id: 'plat',
    label: 'Fond régulier',
    note: 'Rien de marqué là où tu es passé.',
  };
}

/** Y a-t-il de quoi répondre, quelle que soit la source ? */
export const ready = () => soundings.count() > 0 || bathy.ready();

/** Ce qu'on peut afficher sous un chiffre pour dire d'où il sort. */
export function label(d) {
  if (!d) return '—';
  if (d.source === 'carnet') {
    return d.n > 1
      ? `relevé au sondeur · ${d.n} sondes${d.spreadM >= 2 ? ` · pente (${d.spreadM} m d’écart)` : ''}`
      : `relevé au sondeur · à ${d.distanceM} m`;
  }
  return `modèle public${d.resolutionM ? ` · maille ${d.resolutionM} m` : ''}`;
}

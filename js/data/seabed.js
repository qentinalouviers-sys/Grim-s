/* ==========================================================================
 * data/seabed.js — nature des fonds, à bord
 * --------------------------------------------------------------------------
 * Lit la grille produite par scripts/fetch_seabed.py depuis EMODnet.
 *
 * À l'échelle où l'on pêche, le fond est la donnée qui décide : le turbot est
 * sur le sable et le ridin, la dorade grise sur l'épave et la roche, la sole
 * sur la vase. Jusqu'ici l'app le demandait à l'utilisateur, une case à cocher
 * à la fois, marque par marque. Elle peut le savoir.
 *
 * ── CE QUE CE MODULE NE PRÉTEND PAS ───────────────────────────────────────
 * La source est cartographiée au 1:250 000 et rastérisée à ~280 m. C'est une
 * carte de SÉDIMENT DOMINANT, pas un sondeur : elle dit « secteur de sable
 * grossier », pas « la tête de roche est à 12 m sur ta droite ». Une marque
 * relevée au sondeur reste plus juste que cette couche, et l'app ne remplace
 * donc jamais un fond saisi à la main — elle ne fait que le PROPOSER.
 *
 * Le fichier est optionnel : absent, tout continue de fonctionner. C'est la
 * même règle que pour la marée SHOM.
 * ========================================================================== */

let model = null;      // grille décodée, ou null tant qu'on n'a rien
let loading = null;

/**
 * Charge la grille. Le service worker précache le fichier avec la coque, donc
 * l'appel réussit hors ligne dès la deuxième ouverture.
 */
export function init() {
  if (model || loading) return loading || Promise.resolve(model);
  loading = fetch('data/seabed-dieppe.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((spec) => {
      model = spec && spec.rle ? decode(spec) : null;
      return model;
    })
    .catch(() => null)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Décompression des plages en une seule passe. ~100 000 cellules, ~2 ms. */
function decode(spec) {
  const [rows, cols] = spec.size;
  const cells = new Uint8Array(rows * cols);
  let k = 0;
  for (let i = 0; i < spec.rle.length; i += 2) {
    const run = spec.rle[i];
    const value = spec.rle[i + 1];
    if (value) cells.fill(value, k, k + run);
    k += run;
  }
  return {
    cells,
    rows,
    cols,
    south: spec.bbox[0],
    west: spec.bbox[1],
    north: spec.bbox[2],
    east: spec.bbox[3],
    dLat: spec.step[0],
    dLon: spec.step[1],
    classes: spec.classes || [],
    meta: {
      source: spec.source,
      layer: spec.layer,
      licence: spec.licence,
      fetchedAt: spec.fetchedAt,
      resolutionM: Math.round(spec.step[0] * 111000),
    },
  };
}

export const ready = () => !!model;
export const meta = () => model?.meta || null;

/**
 * La grille décodée, pour qui doit la DESSINER.
 *
 * at() répond point par point, ce qui est parfait pour scorer un poste et
 * catastrophique pour peindre un écran : la couche de rendu parcourt les
 * cases, pas les pixels. On expose donc le modèle en lecture — les champs
 * sont les mêmes qu'en interne, et personne d'autre n'a à les connaître.
 */
export const grid = () => model;

/** Toutes les natures de fond connues du secteur, pour une légende. */
export const classes = () => (model ? model.classes.slice(1) : []);

/**
 * Nature du fond sous un point.
 * @returns {{label:string, fr:string, habitat:string|null, resolutionM:number}|null}
 *   null si la grille n'est pas chargée, si le point est hors du secteur
 *   couvert, ou si EMODnet ne cartographie pas cette cellule — trois cas
 *   différents qu'on ne distingue pas ici, parce que la réponse utile est la
 *   même : on ne sait pas, donc on ne dit rien.
 */
export function at(lat, lon) {
  if (!model || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < model.south || lat >= model.north || lon < model.west || lon >= model.east) return null;
  const i = Math.floor((lat - model.south) / model.dLat);
  const j = Math.floor((lon - model.west) / model.dLon);
  const v = model.cells[i * model.cols + j];
  if (!v) return null;
  const c = model.classes[v];
  if (!c) return null;
  return { ...c, resolutionM: model.meta.resolutionM };
}

/**
 * Nature dominante autour d'un point, avec le détail de ce qu'il y a à côté.
 * Sur une marque, c'est souvent plus honnête que la cellule seule : à 280 m de
 * maille, un point posé à la limite de deux sédiments est un point posé au
 * hasard entre les deux, et le voisinage le dit.
 *
 * @param {number} radiusM rayon d'échantillonnage
 * @returns {{dominant:object|null, mix:{c:object, share:number}[]}}
 */
export function around(lat, lon, radiusM = 400) {
  if (!model) return { dominant: null, mix: [] };
  const stepsLat = Math.max(1, Math.round(radiusM / (model.dLat * 111000)));
  const stepsLon = Math.max(1, Math.round(radiusM / (model.dLon * 111000 * 0.64)));
  const counts = new Map();
  let total = 0;
  for (let di = -stepsLat; di <= stepsLat; di++) {
    for (let dj = -stepsLon; dj <= stepsLon; dj++) {
      const c = at(lat + di * model.dLat, lon + dj * model.dLon);
      total++;
      if (!c) continue;
      counts.set(c.label, (counts.get(c.label) || 0) + 1);
    }
  }
  if (!counts.size) return { dominant: null, mix: [] };
  const mix = [...counts.entries()]
    .map(([label, n]) => ({
      c: model.classes.find((x) => x.label === label),
      share: n / total,
    }))
    .filter((m) => m.c)
    .sort((a, b) => b.share - a.share);
  return { dominant: mix[0].c, mix };
}

/** Les identifiants d'habitat de l'app présents autour d'un point. */
export function habitatsAround(lat, lon, radiusM = 400) {
  const { mix } = around(lat, lon, radiusM);
  const out = [];
  for (const m of mix) {
    // Sous 15 %, c'est un coin de cellule voisine : on ne coche pas une case
    // sur un débordement de grille.
    if (m.share < 0.15) continue;
    if (m.c.habitat && !out.includes(m.c.habitat)) out.push(m.c.habitat);
  }
  return out;
}

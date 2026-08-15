/* ==========================================================================
 * data/bathy.js — sonde et relief, à bord
 * --------------------------------------------------------------------------
 * Lit la grille produite par scripts/fetch_bathy.py depuis EMODnet Bathymetry.
 *
 * La carte des fonds dit CE QU'IL Y A ; celle-ci dit OÙ SE PLACER. Les deux
 * partagent la même emprise et la même logique de lecture — et la même
 * honnêteté sur ce qu'elles ne savent pas.
 *
 * ── LE RELIEF, PAS SEULEMENT LA SONDE ─────────────────────────────────────
 * Un pêcheur de bar ne cherche pas « 22 mètres ». Il cherche l'endroit où
 * l'on PASSE de 22 à 16 : le bord du ridin, la lèvre de la fosse, le tombant.
 * C'est là que le courant décolle, que le fourrage se coince et que le
 * prédateur attend. Une sonde seule ne dit rien de ça ; l'écart entre voisins,
 * si. On le calcule à la lecture, sur une fenêtre d'environ un kilomètre :
 *
 *   relief  = écart max-min autour du point
 *   pente   = plus forte différence entre deux cases voisines, en m/100 m
 *
 * ── CE QUE CE MODULE NE PRÉTEND PAS ───────────────────────────────────────
 * La source fait 115 m de maille, agrégée ici à ~300 m. On y lit le plateau
 * côtier et sa cassure, les fosses, les bancs du large. On n'y lit PAS le
 * ridin isolé — 2 à 3 m de haut, quelques centaines de mètres de longueur
 * d'onde — qui est sous la résolution. L'app le dit à chaque affichage, et le
 * sondeur du bord reste le juge.
 *
 * Le fichier est optionnel : absent, tout continue de fonctionner.
 * ========================================================================== */

const LAND = 32767;
const NODATA = 32766;

let model = null;
let loading = null;

export function init() {
  if (model || loading) return loading || Promise.resolve(model);
  loading = fetch('data/bathy-dieppe.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((spec) => {
      model = spec && spec.grid ? decode(spec) : null;
      return model;
    })
    .catch(() => null)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * Miroir exact de encode() côté Python : différences successives en RLE, les
 * sentinelles échappant à la chaîne des différences. ~117 000 cellules, ~3 ms.
 */
function decode(spec) {
  const [rows, cols] = spec.size;
  const cells = new Int16Array(rows * cols);
  const codes = spec.grid;
  let k = 0;
  let prev = 0;
  for (let i = 0; i < codes.length; i += 2) {
    const d = codes[i];
    const n = codes[i + 1];
    if (d >= 30000) {
      cells.fill(d, k, k + n);
      k += n;
    } else {
      for (let r = 0; r < n; r++) {
        prev += d;
        cells[k++] = prev;
      }
    }
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
    meta: {
      source: spec.source,
      coverage: spec.coverage,
      licence: spec.licence,
      fetchedAt: spec.fetchedAt,
      resolutionM: spec.resolutionM,
      depthRangeM: spec.depthRangeM,
    },
  };
}

export const ready = () => !!model;
export const meta = () => model?.meta || null;

function cellAt(lat, lon) {
  if (!model || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < model.south || lat >= model.north || lon < model.west || lon >= model.east) return null;
  const i = Math.floor((lat - model.south) / model.dLat);
  const j = Math.floor((lon - model.west) / model.dLon);
  return { i, j, v: model.cells[i * model.cols + j] };
}

/**
 * Sonde sous un point, en mètres sous le zéro des cartes.
 * @returns {number|null} null hors zone, sur la terre, ou sans mesure.
 */
export function depthAt(lat, lon) {
  const c = cellAt(lat, lon);
  if (!c || c.v === LAND || c.v === NODATA) return null;
  return c.v;
}

/** Hauteur d'eau réelle : la sonde plus la marée du moment. */
export function waterUnder(lat, lon, tideHeightM) {
  const d = depthAt(lat, lon);
  if (d == null) return null;
  return Number.isFinite(tideHeightM) ? d + tideHeightM : d;
}

/**
 * Relief autour d'un point.
 *
 * @param {number} radiusM rayon d'échantillonnage, ~1 km par défaut
 * @returns {{depthM:number, minM:number, maxM:number, reliefM:number,
 *            slopePer100M:number, samples:number, resolutionM:number,
 *            structure:{id:string,label:string,note:string}}|null}
 */
/* Un relief() coûte une soixantaine de lectures de grille. Le moteur de postes
 * le demande pour chaque poste et chaque instant scoré, sur des positions qui
 * ne bougent pas : on mémorise à la case près. */
const reliefCache = new Map();

export function relief(lat, lon, radiusM = 900) {
  if (!model) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${radiusM}`;
  if (reliefCache.has(key)) return reliefCache.get(key);
  const out = computeRelief(lat, lon, radiusM);
  // Garde-fou mémoire : une marque personnelle par mille sur tout le secteur
  // ne dépasse pas quelques milliers d'entrées ; au-delà on repart à zéro
  // plutôt que de faire enfler l'onglet.
  if (reliefCache.size > 4000) reliefCache.clear();
  reliefCache.set(key, out);
  return out;
}

function computeRelief(lat, lon, radiusM) {
  const centre = depthAt(lat, lon);
  if (centre == null) return null;

  const di = Math.max(1, Math.round(radiusM / (model.dLat * 111320)));
  const dj = Math.max(1, Math.round(radiusM / (model.dLon * 111320 * 0.64)));

  let min = centre;
  let max = centre;
  let samples = 0;
  let maxStep = 0;
  const stepLatM = model.dLat * 111320;
  const stepLonM = model.dLon * 111320 * 0.64;

  for (let a = -di; a <= di; a++) {
    for (let b = -dj; b <= dj; b++) {
      const v = depthAt(lat + a * model.dLat, lon + b * model.dLon);
      if (v == null) continue;
      samples++;
      if (v < min) min = v;
      if (v > max) max = v;
      // Pente locale : on compare à la case immédiatement à l'est et au nord,
      // pas au centre — c'est la RUPTURE qu'on cherche, pas la déclivité
      // moyenne, et une falaise sous-marine se voit entre deux cases voisines.
      const e = depthAt(lat + a * model.dLat, lon + (b + 1) * model.dLon);
      if (e != null) maxStep = Math.max(maxStep, Math.abs(e - v) / stepLonM * 100);
      const n = depthAt(lat + (a + 1) * model.dLat, lon + b * model.dLon);
      if (n != null) maxStep = Math.max(maxStep, Math.abs(n - v) / stepLatM * 100);
    }
  }
  if (samples < 4) return null;

  const reliefM = max - min;
  return {
    depthM: centre,
    minM: min,
    maxM: max,
    reliefM,
    slopePer100M: Math.round(maxStep * 10) / 10,
    samples,
    resolutionM: model.meta.resolutionM,
    structure: classify(centre, reliefM, maxStep),
  };
}

/**
 * Nommer ce qu'on voit. Les seuils sont ceux de la Manche orientale : un
 * plateau à 4 m d'écart sur un kilomètre y est déjà un accident marquant,
 * là où le même chiffre au large de la Bretagne ne serait rien.
 */
function classify(depth, reliefM, slope) {
  if (slope >= 3.5 || reliefM >= 12) {
    return {
      id: 'tombant',
      label: 'Cassure franche',
      note: 'Le fond décroche ici. C’est le poste : le courant décolle sur la marche et le fourrage s’y coince.',
    };
  }
  if (reliefM >= 6) {
    return {
      id: 'relief',
      label: 'Relief marqué',
      note: 'Accident net dans le secteur. Sonde le bord amont dans le courant plutôt que le sommet.',
    };
  }
  if (reliefM >= 2.5) {
    return {
      id: 'ondule',
      label: 'Fond ondulé',
      note: 'Vallonné — probablement un champ de ridins. À cette maille on voit le champ, pas la ride : le sondeur prendra le relais.',
    };
  }
  if (depth >= 30) {
    return { id: 'plaine', label: 'Plaine du large', note: 'Fond régulier. Cherche le relief ou l’épave plutôt que de dériver au hasard.' };
  }
  return { id: 'plat', label: 'Fond plat', note: 'Rien de marquant au kilomètre. Le poisson y passe, il n’y tient pas poste.' };
}

/**
 * Le meilleur accident dans un rayon donné, et son relèvement — la réponse à
 * « je suis là, où est la cassure la plus proche ? ».
 *
 * @returns {{lat:number, lon:number, distM:number, bearingDeg:number,
 *            relief:object}|null}
 */
export function nearestBreak(lat, lon, radiusM = 2500) {
  if (!model) return null;
  const di = Math.max(1, Math.round(radiusM / (model.dLat * 111320)));
  const dj = Math.max(1, Math.round(radiusM / (model.dLon * 111320 * 0.64)));
  let best = null;

  for (let a = -di; a <= di; a++) {
    for (let b = -dj; b <= dj; b++) {
      const la = lat + a * model.dLat;
      const lo = lon + b * model.dLon;
      const v = depthAt(la, lo);
      if (v == null || v < 3) continue;
      const e = depthAt(la, lo + model.dLon);
      const n = depthAt(la + model.dLat, lo);
      const step = Math.max(
        e == null ? 0 : Math.abs(e - v),
        n == null ? 0 : Math.abs(n - v),
      );
      if (step < 2) continue;
      const distM = Math.hypot(a * model.dLat * 111320, b * model.dLon * 111320 * 0.64);
      if (distM > radiusM) continue;
      // On veut la marche la plus haute, pas la plus proche : une cassure de
      // six mètres à un mille bat une bosse d'un mètre à trois cents.
      const merit = step - distM / 1200;
      if (!best || merit > best.merit) {
        best = { lat: la, lon: lo, distM: Math.round(distM), stepM: step, merit };
      }
    }
  }
  if (!best) return null;
  const dLatM = (best.lat - lat) * 111320;
  const dLonM = (best.lon - lon) * 111320 * 0.64;
  const bearingDeg = (Math.atan2(dLonM, dLatM) * 180 / Math.PI + 360) % 360;
  return {
    lat: best.lat,
    lon: best.lon,
    distM: best.distM,
    stepM: best.stepM,
    bearingDeg: Math.round(bearingDeg),
    relief: relief(best.lat, best.lon),
  };
}

/* ==========================================================================
 * data/seamarks.js — balisage maritime : bouées, feux, amers
 * --------------------------------------------------------------------------
 * D'où viennent les données : OpenStreetMap, via l'API Overpass. Libre,
 * gratuite, sans clé, sans compte. C'est la même source que la surcouche
 * OpenSeaMap déjà affichée sur la carte — sauf qu'ici on ne récupère pas des
 * IMAGES de bouées, on récupère les BOUÉES : leur nom, leur catégorie, la
 * couleur de leur feu, son rythme, sa période, sa portée nominale, sa hauteur.
 *
 * Ce que ça permet, et qu'aucune tuile ne permettra jamais :
 *
 *   • répondre à « c'est quoi, ce feu, là-bas ? » à trois heures du matin ;
 *   • dire ce qui est RÉELLEMENT visible depuis le bateau, en croisant portée
 *     lumineuse, portée géographique (courbure de la Terre !) et visibilité
 *     météo — un feu de 12 milles à 9 mètres de haut ne se voit pas à 12 milles
 *     depuis un cockpit à 2 mètres, il se voit à 8,9 ;
 *   • proposer chaque marque comme but de navigation.
 *
 * ── PORTÉE GÉOGRAPHIQUE ───────────────────────────────────────────────────
 * Formule classique des Instructions Nautiques, en milles marins :
 *
 *      D = 2,03 × ( √hauteur_œil + √hauteur_feu )       hauteurs en mètres
 *
 * Le coefficient tient compte de la réfraction atmosphérique moyenne. Au-delà
 * de cette distance le feu est sous l'horizon : sa portée nominale ne sert plus
 * à rien, on ne voit au mieux que le halo dans le ciel.
 *
 * ── HORS LIGNE ────────────────────────────────────────────────────────────
 * Une requête couvre 30 km autour du point demandé et se garde un mois dans
 * IndexedDB (core/net.js). On télécharge au port, on s'en sert au large. Sans
 * réseau et sans cache, l'écran le dit franchement au lieu de rester vide.
 * ========================================================================== */

import * as net from '../core/net.js';
import { distance, bearing } from '../core/geo.js';

/* Miroirs Overpass. Le premier est le serveur de référence ; il rend parfois
 * un 429 quand il est chargé, et on n'a aucune raison d'échouer pour ça. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Hauteur d'œil par défaut, en mètres : un cockpit de bateau de pêche côtier. */
export const DEFAULT_EYE_HEIGHT_M = 2;

const MONTH = 30 * 24 * 3600000;

/* --------------------------------------------------------------------------
 * Chargement
 * ------------------------------------------------------------------------ */

let cache = { marks: [], center: null, fetchedAt: 0, radiusKm: 0, source: 'none' };

export const current = () => cache;

/**
 * Charge le balisage autour d'une position.
 * @param {{lat:number, lon:number}} pos
 * @param {{radiusKm?:number, force?:boolean}} [opts]
 */
export async function load(pos, opts = {}) {
  const radiusKm = opts.radiusKm ?? 30;
  // La clé est arrondie au centième de degré (~1 km) : bouger de trois cents
  // mètres ne doit pas redéclencher un téléchargement de 30 km de rayon.
  const key = `seamarks:${pos.lat.toFixed(2)},${pos.lon.toFixed(2)},${radiusKm}`;
  const query =
    `[out:json][timeout:40];(` +
    `node(around:${radiusKm * 1000},${pos.lat.toFixed(5)},${pos.lon.toFixed(5)})["seamark:type"];` +
    `way(around:${radiusKm * 1000},${pos.lat.toFixed(5)},${pos.lon.toFixed(5)})["seamark:type"];` +
    `);out center tags;`;

  let res = null;
  for (const ep of ENDPOINTS) {
    res = await net.getJSON(`${ep}?data=${encodeURIComponent(query)}`, {
      key,
      maxAgeMs: opts.force ? 0 : MONTH,
      timeoutMs: 25000,
      force: opts.force,
    });
    if (res.data) break;
  }

  if (!res?.data?.elements) {
    return { ...cache, error: true };
  }
  const marks = res.data.elements.map(parseElement).filter(Boolean);
  cache = {
    marks,
    center: { lat: pos.lat, lon: pos.lon },
    radiusKm,
    fetchedAt: res.fetchedAt,
    stale: res.stale,
    source: res.source,
  };
  return cache;
}

/* --------------------------------------------------------------------------
 * Analyse des tags OpenSeaMap
 * ------------------------------------------------------------------------ */

const COLOUR_ABBR = {
  white: 'W', red: 'R', green: 'G', yellow: 'Y', blue: 'Bu',
  orange: 'Or', amber: 'Am', violet: 'Vi', black: 'B', grey: 'Gy',
};

const COLOUR_CSS = {
  white: '#f1f5f9', red: '#ef4444', green: '#22c55e', yellow: '#facc15',
  blue: '#3b82f6', orange: '#fb923c', amber: '#fbbf24', violet: '#a78bfa',
  black: '#0f172a', grey: '#64748b',
};

/** Familles retenues. Le reste du balisage OSM est du mobilier portuaire. */
const KEEP = new Set([
  'buoy_cardinal', 'buoy_lateral', 'buoy_safe_water', 'buoy_special_purpose',
  'buoy_isolated_danger', 'buoy_installation',
  'beacon_cardinal', 'beacon_lateral', 'beacon_safe_water',
  'beacon_special_purpose', 'beacon_isolated_danger',
  'light_major', 'light_minor', 'light_float', 'light_vessel', 'light',
  'landmark', 'platform', 'wreck', 'rock', 'obstruction',
  'mooring', 'pile', 'signal_station_warning', 'radar_transponder',
]);

const FAMILY_LABEL = {
  buoy_cardinal: 'Bouée cardinale',
  beacon_cardinal: 'Balise cardinale',
  buoy_lateral: 'Bouée latérale',
  beacon_lateral: 'Balise latérale',
  buoy_safe_water: 'Bouée d’eaux saines',
  beacon_safe_water: 'Balise d’eaux saines',
  buoy_isolated_danger: 'Danger isolé',
  beacon_isolated_danger: 'Danger isolé',
  buoy_special_purpose: 'Bouée spéciale',
  beacon_special_purpose: 'Balise spéciale',
  buoy_installation: 'Bouée d’installation',
  light_major: 'Feu principal',
  light_minor: 'Feu secondaire',
  light_float: 'Bateau-feu',
  light_vessel: 'Bateau-feu',
  light: 'Feu',
  landmark: 'Amer',
  platform: 'Plateforme',
  wreck: 'Épave',
  rock: 'Roche',
  obstruction: 'Obstruction',
  mooring: 'Corps-mort',
  pile: 'Pieu',
  signal_station_warning: 'Sémaphore',
  radar_transponder: 'Racon',
};

const CARDINAL_LABEL = { north: 'Nord', east: 'Est', south: 'Sud', west: 'Ouest' };

function parseElement(e) {
  const t = e.tags || {};
  const type = t['seamark:type'];
  if (!type || !KEEP.has(type)) return null;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const category = t[`seamark:${type}:category`] || null;
  const colours = (t[`seamark:${type}:colour`] || '').split(';').filter(Boolean);
  const shape = t[`seamark:${type}:shape`] || null;

  return {
    id: `${e.type}/${e.id}`,
    lat,
    lon,
    type,
    family: FAMILY_LABEL[type] || 'Marque',
    name: t['seamark:name'] || t.name || null,
    category,
    colours,
    shape,
    topmark: t['seamark:topmark:shape'] || null,
    topmarkColour: t['seamark:topmark:colour'] || null,
    heightM: num(t['seamark:light:height'] ?? t[`seamark:${type}:height`] ?? t['seamark:elevation'] ?? t.height),
    light: parseLight(t),
    reflector: t['seamark:radar_reflector'] === 'yes',
    racon: type === 'radar_transponder' || !!t['seamark:radar_transponder:category'],
    fogSignal: t['seamark:fog_signal:category'] || null,
  };
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Feu. OSM décrit soit un feu simple (`seamark:light:*`), soit un feu à
 * secteurs numérotés (`seamark:light:1:*`). On gère les deux, parce qu'en
 * approche d'un port c'est précisément le feu à secteurs qui compte.
 */
function parseLight(t) {
  const sectors = [];
  for (let i = 1; i <= 12; i++) {
    const c = t[`seamark:light:${i}:colour`];
    if (!c) continue;
    sectors.push({
      colour: c,
      character: t[`seamark:light:${i}:character`] || t['seamark:light:character'] || null,
      group: t[`seamark:light:${i}:group`] || t['seamark:light:group'] || null,
      periodS: num(t[`seamark:light:${i}:period`] ?? t['seamark:light:period']),
      rangeNm: num(t[`seamark:light:${i}:range`] ?? t['seamark:light:range']),
      fromDeg: num(t[`seamark:light:${i}:sector_start`]),
      toDeg: num(t[`seamark:light:${i}:sector_end`]),
    });
  }

  const character = t['seamark:light:character'] || sectors[0]?.character || null;
  const colour = t['seamark:light:colour'] || null;
  const colours = colour ? colour.split(';').filter(Boolean) : [...new Set(sectors.map((s) => s.colour))];
  if (!character && !colours.length) return null;

  return {
    character,
    group: t['seamark:light:group'] || sectors[0]?.group || null,
    colours,
    periodS: num(t['seamark:light:period']) ?? sectors[0]?.periodS ?? null,
    rangeNm: num(t['seamark:light:range']) ?? (Math.max(0, ...sectors.map((s) => s.rangeNm || 0)) || null),
    heightM: num(t['seamark:light:height']),
    sectors,
  };
}

/**
 * Caractéristique au format des cartes marines : Fl(2)R.6s8M.
 * On l'écrit comme elle est imprimée, pas comme elle est stockée : c'est cette
 * chaîne-là qu'on compare avec la carte papier posée sur le banc.
 */
export function lightString(light) {
  if (!light) return '';
  const ch = (light.character || '').replace(/\s+/g, '');
  const grp = light.group ? `(${light.group})` : '';
  const col = light.colours.map((c) => COLOUR_ABBR[c] || c[0]?.toUpperCase() || '').join('');
  const per = light.periodS ? `.${trimNum(light.periodS)}s` : '';
  const rng = light.rangeNm ? ` ${trimNum(light.rangeNm)}M` : '';
  return `${ch}${grp}${col}${per}${rng}`.trim();
}

const trimNum = (n) => String(Number(n.toFixed(1))).replace(/\.0$/, '');

/** Libellé lisible : « Bouée cardinale Nord », « Feu principal ». */
export function describe(m) {
  if (m.type.endsWith('cardinal') && m.category) {
    return `${m.family} ${CARDINAL_LABEL[m.category] || m.category}`;
  }
  if (m.type.endsWith('lateral') && m.category) {
    const side = { port: 'bâbord', starboard: 'tribord', preferred_channel_port: 'chenal préféré bâbord', preferred_channel_starboard: 'chenal préféré tribord' }[m.category];
    return `${m.family} ${side || m.category}`;
  }
  if (m.category) return `${m.family} · ${m.category.replace(/_/g, ' ')}`;
  return m.family;
}

/** Couleurs CSS des bandes, pour le dessin du fût. */
export const cssColours = (m) =>
  (m.colours.length ? m.colours : ['grey']).map((c) => COLOUR_CSS[c] || '#94a3b8');

export const lightCss = (l) => (l?.colours?.length ? COLOUR_CSS[l.colours[0]] || '#f1f5f9' : null);

/* --------------------------------------------------------------------------
 * Visibilité
 * ------------------------------------------------------------------------ */

/**
 * Portée géographique d'un feu, en milles marins.
 * @param {number} lightHeightM hauteur du feu au-dessus du niveau de la mer
 * @param {number} eyeHeightM   hauteur d'œil de l'observateur
 */
export function geographicRangeNm(lightHeightM, eyeHeightM = DEFAULT_EYE_HEIGHT_M) {
  const hl = Math.max(0, lightHeightM || 0);
  const he = Math.max(0.5, eyeHeightM || DEFAULT_EYE_HEIGHT_M);
  return 2.03 * (Math.sqrt(hl) + Math.sqrt(he));
}

/**
 * Le feu est-il visible d'ici, maintenant ?
 * Trois plafonds successifs, et on dit lequel mord — parce que « pas visible »
 * sans raison ne permet pas de décider s'il faut s'approcher ou attendre le
 * lever du jour.
 * @returns {{visible:boolean, limitNm:number, limitedBy:string, distanceNm:number}}
 */
export function visibility(m, from, { eyeHeightM = DEFAULT_EYE_HEIGHT_M, visibilityM = null } = {}) {
  const distanceNm = distance(from, m) / 1852;
  if (!m.light) {
    // Marque non lumineuse : on la voit de jour, à vue, et c'est tout.
    const geo = geographicRangeNm(m.heightM ?? 3, eyeHeightM);
    return {
      visible: distanceNm <= geo,
      limitNm: geo,
      limitedBy: 'horizon',
      distanceNm,
      lit: false,
    };
  }

  const geo = geographicRangeNm(m.light.heightM ?? m.heightM ?? 5, eyeHeightM);
  const nominal = m.light.rangeNm || 99;
  const meteo = visibilityM != null ? visibilityM / 1852 : 99;

  const limits = [
    { nm: geo, by: 'horizon' },
    { nm: nominal, by: 'portée du feu' },
    { nm: meteo, by: 'visibilité météo' },
  ].sort((a, b) => a.nm - b.nm);

  return {
    visible: distanceNm <= limits[0].nm,
    limitNm: limits[0].nm,
    limitedBy: limits[0].by,
    distanceNm,
    lit: true,
    geographicNm: geo,
    nominalNm: m.light.rangeNm || null,
  };
}

/* --------------------------------------------------------------------------
 * Sélection
 * ------------------------------------------------------------------------ */

/**
 * Marques autour d'une position, enrichies du relèvement et de la distance.
 * @param {{lat,lon}} from
 * @param {{maxNm?:number, limit?:number, litOnly?:boolean, eyeHeightM?:number,
 *          visibilityM?:number}} [opts]
 */
export function nearby(from, opts = {}) {
  const { maxNm = 12, limit = 60, litOnly = false } = opts;
  const out = [];
  for (const m of cache.marks) {
    if (litOnly && !m.light) continue;
    const d = distance(from, m) / 1852;
    if (d > maxNm) continue;
    out.push({
      ...m,
      distanceNm: d,
      distanceM: d * 1852,
      bearingDeg: bearing(from, m),
      vis: visibility(m, from, opts),
    });
  }
  return out.sort((a, b) => a.distanceNm - b.distanceNm).slice(0, limit);
}

/* --------------------------------------------------------------------------
 * Identification d'un feu observé
 * --------------------------------------------------------------------------
 * Le vrai geste de nuit : on voit un éclat rouge quelque part au 040, on compte
 * « un… deux… », et on cherche sur la carte lequel c'est. Ici on inverse le
 * problème — on décrit ce qu'on voit, l'app propose les candidats classés.
 *
 * Le score est volontairement transparent : chaque critère rapporte des points
 * qu'on affiche. Un classement dont on ne comprend pas la logique n'est pas
 * utilisable pour une décision de nuit.
 * ------------------------------------------------------------------------ */

/**
 * @param {{colour?:string, character?:string, periodS?:number, bearingDeg?:number}} obs
 * @param {{lat,lon}} from
 * @param {{maxNm?:number, eyeHeightM?:number, visibilityM?:number}} [opts]
 */
export function identify(obs, from, opts = {}) {
  const candidates = nearby(from, { ...opts, maxNm: opts.maxNm ?? 20, limit: 400, litOnly: true });
  const scored = [];

  for (const m of candidates) {
    const l = m.light;
    const reasons = [];
    let score = 0;

    if (obs.colour) {
      if (l.colours.includes(obs.colour)) {
        score += 40;
        reasons.push('couleur');
      } else if (l.colours.length) {
        continue; // une couleur qui ne colle pas élimine, elle ne pénalise pas
      }
    }

    if (obs.character && l.character) {
      const a = l.character.toUpperCase();
      const b = obs.character.toUpperCase();
      if (a === b) {
        score += 30;
        reasons.push('rythme');
      } else if (a.startsWith(b) || b.startsWith(a)) {
        score += 12;
      } else {
        score -= 25;
      }
    }

    if (obs.periodS && l.periodS) {
      const delta = Math.abs(l.periodS - obs.periodS);
      if (delta < 0.7) {
        score += 30;
        reasons.push(`période à ${delta.toFixed(1)} s près`);
      } else if (delta < 1.6) score += 14;
      else if (delta > 3) score -= 20;
    }

    if (Number.isFinite(obs.bearingDeg)) {
      const off = Math.abs(((m.bearingDeg - obs.bearingDeg + 540) % 360) - 180);
      if (off < 12) {
        score += 25;
        reasons.push('relèvement');
      } else if (off < 30) score += 8;
      else score -= 30;
    }

    // Un feu sous l'horizon n'est pas celui qu'on regarde.
    if (!m.vis.visible) {
      score -= 35;
      reasons.push(`hors de portée (${m.vis.limitedBy})`);
    } else {
      score += 10;
    }

    scored.push({ ...m, score, reasons });
  }

  return scored.sort((a, b) => b.score - a.score).filter((c) => c.score > 0).slice(0, 8);
}

/** Rythmes proposés à la saisie, avec leur nom en clair. */
export const CHARACTERS = [
  ['Fl', 'Éclats (Fl)'],
  ['LFl', 'Éclat long (LFl)'],
  ['Oc', 'Occultations (Oc)'],
  ['Iso', 'Isophase (Iso)'],
  ['Q', 'Scintillant (Q)'],
  ['VQ', 'Scintillant rapide (VQ)'],
  ['F', 'Fixe (F)'],
  ['Al', 'Alternatif (Al)'],
];

export const COLOURS = [
  ['white', 'Blanc'],
  ['red', 'Rouge'],
  ['green', 'Vert'],
  ['yellow', 'Jaune'],
];

export { COLOUR_CSS };

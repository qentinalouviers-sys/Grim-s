/* ==========================================================================
 * core/geo.js — géodésie marine
 * --------------------------------------------------------------------------
 * Sphère de rayon 6371008.8 m (rayon moyen WGS84). Sur une zone de 30 milles
 * l'écart au ellipsoïde reste sous 0,1 % : largement sous l'incertitude du
 * modèle de courant. Pas de proj4, pas de turf.
 *
 * Convention : tous les caps sont en degrés vrais [0,360), toutes les
 * distances en mètres, toutes les vitesses en nœuds sauf mention contraire.
 * Un « vecteur » est {dir, spd} — direction VERS laquelle ça va (convention
 * courant, pas convention vent).
 * ========================================================================== */

export const R_EARTH = 6371008.8;
export const M_PER_NM = 1852;

export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

/** Ramène un angle dans [0,360). */
export const norm360 = (d) => ((d % 360) + 360) % 360;

/** Écart signé le plus court entre deux caps, dans [-180,180]. */
export function angleDiff(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** Interpolation angulaire au plus court chemin. */
export function lerpAngle(a, b, f) {
  return norm360(a + angleDiff(b, a) * f);
}

/** Moyenne circulaire d'une liste de caps (pondérée si weights fourni). */
export function meanAngle(angles, weights) {
  let x = 0;
  let y = 0;
  angles.forEach((a, i) => {
    const w = weights ? weights[i] : 1;
    x += w * Math.cos(toRad(a));
    y += w * Math.sin(toRad(a));
  });
  if (x === 0 && y === 0) return 0;
  return norm360(toDeg(Math.atan2(y, x)));
}

/** Distance grand cercle en mètres. Haversine (stable aux petites distances). */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cap initial (route orthodromique) de a vers b, en degrés vrais. */
export function bearing(a, b) {
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return norm360(toDeg(Math.atan2(y, x)));
}

/** Point à `dist` mètres dans l'azimut `brg` depuis `p`. */
export function destination(p, brg, dist) {
  const d = dist / R_EARTH;
  const b = toRad(brg);
  const la1 = toRad(p.lat);
  const lo1 = toRad(p.lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return { lat: toDeg(la2), lon: norm360(toDeg(lo2) + 180) - 180 };
}

/**
 * Déplacement par composantes est/nord en mètres. Sur nos échelles c'est
 * équivalent à destination() mais évite deux atan2 dans les boucles
 * d'intégration de dérive, appelées quelques milliers de fois par rendu.
 */
export function offsetMeters(p, east, north) {
  const dLat = north / R_EARTH;
  const dLon = east / (R_EARTH * Math.cos(toRad(p.lat)));
  return { lat: p.lat + toDeg(dLat), lon: p.lon + toDeg(dLon) };
}

/** {dir, spd} → {east, north} dans la même unité que spd. */
export function vecToEN(v) {
  const r = toRad(v.dir);
  return { east: v.spd * Math.sin(r), north: v.spd * Math.cos(r) };
}

/** {east, north} → {dir, spd}. */
export function enToVec(east, north) {
  return { dir: norm360(toDeg(Math.atan2(east, north))), spd: Math.hypot(east, north) };
}

/** Somme vectorielle de {dir,spd}. */
export function addVectors(...vs) {
  let e = 0;
  let n = 0;
  for (const v of vs) {
    if (!v || !Number.isFinite(v.spd)) continue;
    const c = vecToEN(v);
    e += c.east;
    n += c.north;
  }
  return enToVec(e, n);
}

/* --------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------ */

/**
 * Écart latéral (cross-track) en mètres d'un point par rapport à la route
 * from → to. Positif = à droite de la route.
 */
export function crossTrack(p, from, to) {
  const d13 = distance(from, p) / R_EARTH;
  const t13 = toRad(bearing(from, p));
  const t12 = toRad(bearing(from, to));
  return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * R_EARTH;
}

/**
 * CPA / TCPA entre deux mobiles supposés à vitesse constante.
 * Utilisé pour l'alerte de rapprochement sur un danger fixe (spd2 = 0)
 * ou sur une bouée dérivante. Retourne { cpaM, tcpaS } — tcpaS négatif
 * si le point d'approche minimale est derrière.
 */
export function cpa(p1, v1, p2, v2) {
  const rel = {
    east: vecToEN(v1).east - vecToEN(v2).east,
    north: vecToEN(v1).north - vecToEN(v2).north,
  };
  // Position relative en mètres, approximation plane locale.
  const east = distance({ lat: p1.lat, lon: p1.lon }, { lat: p1.lat, lon: p2.lon }) * Math.sign(p2.lon - p1.lon);
  const north = distance({ lat: p1.lat, lon: p1.lon }, { lat: p2.lat, lon: p1.lon }) * Math.sign(p2.lat - p1.lat);
  const vE = -rel.east * (M_PER_NM / 3600);
  const vN = -rel.north * (M_PER_NM / 3600); // nœuds → m/s
  const v2sum = vE * vE + vN * vN;
  if (v2sum < 1e-9) return { cpaM: Math.hypot(east, north), tcpaS: 0 };
  const tcpaS = -(east * vE + north * vN) / v2sum;
  const cE = east + vE * tcpaS;
  const cN = north + vN * tcpaS;
  return { cpaM: Math.hypot(cE, cN), tcpaS };
}

/** Aire d'un polygone lat/lon en m² (formule du lacet, plan local). */
export function polygonArea(pts) {
  if (pts.length < 3) return 0;
  const lat0 = pts[0].lat;
  const kx = (Math.PI / 180) * R_EARTH * Math.cos(toRad(lat0));
  const ky = (Math.PI / 180) * R_EARTH;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.lon * kx * (q.lat * ky) - q.lon * kx * (p.lat * ky);
  }
  return Math.abs(a / 2);
}

/* --------------------------------------------------------------------------
 * Déclinaison magnétique
 * --------------------------------------------------------------------------
 * Embarquer l'IGRF complet (~2000 coefficients) pour une app qui ne quitte
 * pas la Manche est absurde. Modèle linéaire local calé sur la Seine-Maritime :
 * ~0,7° E en 2025, dérive +0,15°/an, gradient spatial négligeable sur 50 NM.
 * Recalé à chaque révision du WMM. L'erreur reste sous 0,3° sur la zone,
 * soit dix fois moins que le bruit d'un magnétomètre de téléphone à bord.
 * ------------------------------------------------------------------------ */
const DECL_REF = { year: 2025.0, value: 0.7, drift: 0.15 };

/** Déclinaison en degrés (positif = Est) à la date donnée. */
export function declination(date = new Date()) {
  const y = date.getUTCFullYear() + date.getUTCMonth() / 12;
  return DECL_REF.value + (y - DECL_REF.year) * DECL_REF.drift;
}

/** Cap magnétique → cap vrai. */
export const magToTrue = (m, date) => norm360(m + declination(date));
/** Cap vrai → cap magnétique. */
export const trueToMag = (t, date) => norm360(t - declination(date));

/* --------------------------------------------------------------------------
 * GPX
 * ------------------------------------------------------------------------ */

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[c]};`);

/**
 * Export GPX 1.1 — accepté par OpenCPN, Navionics, qgis, Garmin.
 * @param {{name:string, points:{lat,lon,t?,speedKn?}[]}[]} tracks
 * @param {{lat,lon,name,desc?}[]} waypoints
 */
export function toGPX(tracks = [], waypoints = []) {
  const wpts = waypoints
    .map(
      (w) =>
        `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n` +
        `    <name>${xmlEscape(w.name)}</name>\n` +
        (w.desc ? `    <desc>${xmlEscape(w.desc)}</desc>\n` : '') +
        `  </wpt>`,
    )
    .join('\n');
  const trks = tracks
    .map((t) => {
      const seg = t.points
        .map(
          (p) =>
            `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">` +
            (p.t ? `<time>${new Date(p.t).toISOString()}</time>` : '') +
            `</trkpt>`,
        )
        .join('\n');
      return `  <trk><name>${xmlEscape(t.name)}</name><trkseg>\n${seg}\n  </trkseg></trk>`;
    })
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Grim's Compagnon" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `${wpts}\n${trks}\n</gpx>\n`
  );
}

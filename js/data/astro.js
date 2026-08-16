/* ==========================================================================
 * data/astro.js — soleil et lune, calculés à bord
 * --------------------------------------------------------------------------
 * Aucune requête réseau. C'est un choix d'architecture, pas une optimisation :
 * l'heure du coucher de soleil est une donnée de SÉCURITÉ (feux de route,
 * heure de rentrée) et une donnée de PÊCHE (le crépuscule vaut la moitié du
 * score du bar). Elle ne peut pas dépendre d'une API.
 *
 * Soleil  : équation du lever/coucher NOAA — précision ~1 min sous 60° de
 *           latitude, très au-delà de ce dont on a besoin.
 * Lune    : série ELP tronquée (Meeus, chapitre 47 simplifié) — phase à ~1 %,
 *           lever/coucher à ~5 min. Suffisant : la lune n'entre pas dans le
 *           scoring (elle agit déjà par le coefficient), elle sert à la
 *           visibilité nocturne et au confort de lecture.
 * ========================================================================== */

import { toRad, toDeg, norm360 } from '../core/geo.js';

const J2000 = 2451545.0;
const DAY_MS = 86400000;
const OBLIQUITY = 23.4397;

const sin = (d) => Math.sin(toRad(d));
const cos = (d) => Math.cos(toRad(d));

export const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + 2440588;
export const fromJulian = (j) => new Date((j + 0.5 - 2440588) * DAY_MS);
export const daysSinceJ2000 = (date) => toJulian(date) - J2000;

/* --------------------------------------------------------------------------
 * Soleil
 * ------------------------------------------------------------------------ */

function solarMeanAnomaly(d) {
  return norm360(357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M) {
  const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M);
  return norm360(M + C + 180 + 102.9372); // + périhélie
}

function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return {
    dec: toDeg(Math.asin(sin(OBLIQUITY) * sin(L))),
    ra: toDeg(Math.atan2(cos(OBLIQUITY) * sin(L), cos(L))),
    M,
    L,
  };
}

/** Temps sidéral moyen de Greenwich, en degrés. */
function gmst(d) {
  return norm360(280.16 + 360.9856235 * d);
}

/** Hauteur du soleil (degrés) au-dessus de l'horizon vrai. */
export function sunAltitude(date, lat, lon) {
  const d = daysSinceJ2000(date);
  const c = sunCoords(d);
  const H = norm360(gmst(d) + lon - c.ra);
  return toDeg(
    Math.asin(sin(lat) * sin(c.dec) + cos(lat) * cos(c.dec) * cos(H)),
  );
}

/**
 * Événements solaires du jour local contenant `date`.
 * h0 = -0.833° (réfraction + demi-diamètre) pour lever/coucher,
 * -6° crépuscule civil, -12° crépuscule nautique (celui qui compte à bord).
 */
export function sunTimes(date, lat, lon) {
  const d0 = Math.round(daysSinceJ2000(date) - 0.5 - lon / 360);
  const Jnoon = J2000 + 0.0009 - lon / 360 + d0;
  const M = solarMeanAnomaly(Jnoon - J2000);
  const L = eclipticLongitude(M);
  const Jtransit = Jnoon + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const dec = toDeg(Math.asin(sin(L) * sin(OBLIQUITY)));

  const hourAngle = (h0) => {
    const c = (sin(h0) - sin(lat) * sin(dec)) / (cos(lat) * cos(dec));
    if (c > 1) return null; // le soleil ne se lève pas
    if (c < -1) return null; // il ne se couche pas
    return toDeg(Math.acos(c));
  };

  const pair = (h0) => {
    const w = hourAngle(h0);
    if (w === null) return { rise: null, set: null };
    return {
      rise: fromJulian(Jtransit - w / 360).valueOf(),
      set: fromJulian(Jtransit + w / 360).valueOf(),
    };
  };

  const official = pair(-0.833);
  const civil = pair(-6);
  const nautical = pair(-12);
  const golden = pair(6); // heure dorée : lumière rasante, la fenêtre du bar

  return {
    transit: fromJulian(Jtransit).valueOf(),
    sunriseT: official.rise,
    sunsetT: official.set,
    civilDawnT: civil.rise,
    civilDuskT: civil.set,
    nauticalDawnT: nautical.rise,
    nauticalDuskT: nautical.set,
    goldenMorningEndT: golden.rise,
    goldenEveningStartT: golden.set,
    declination: dec,
    dayLengthMs: official.rise && official.set ? official.set - official.rise : null,
  };
}

/**
 * Événements solaires du jour local qui contient `t` — quelle que soit l'HEURE
 * de `t`.
 *
 * ── POURQUOI CETTE FONCTION EXISTE ────────────────────────────────────────
 * `sunTimes()` choisit son jour solaire par `Math.round(jours − 0.5)` : le
 * découpage se fait autour de MIDI, pas de minuit. Lui passer un instant du
 * matin renvoie donc, selon la longitude, le lever et le coucher de la VEILLE.
 * L'erreur est silencieuse — les valeurs sont plausibles, juste décalées d'un
 * jour — et elle a réellement mordu : un test « cette heure est-elle de jour ? »
 * comparait mardi 08 h au coucher du LUNDI, concluait « nuit », et une fenêtre
 * de beau temps de sept heures n'était jamais annoncée.
 *
 * On normalise donc sur midi local avant d'appeler. Tout code qui demande le
 * soleil d'un JOUR doit passer par ici ; `sunTimes()` reste pour qui sait ce
 * qu'il fait.
 */
export function sunTimesOfDay(t, lat, lon) {
  const day0 = new Date(t);
  day0.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day0);
  dayEnd.setDate(dayEnd.getDate() + 1);

  /* Viser midi ne suffit PAS, et c'est le piège qui a coûté deux passes :
   * `Math.round(jours − 0.5 − lon/360)` bascule exactement à midi solaire. À
   * midi UTC et par longitude est faible — Dieppe, 1.08° E — l'argument vaut
   * N − 0.503, qui s'arrondit à N − 1. On tombe pile du mauvais côté, et on
   * récupère la veille en croyant viser le bon jour.
   *
   * Plutôt que de décaler la sonde d'une heure au jugé — ce qui déplace le
   * problème vers un autre fuseau ou une autre longitude — on VÉRIFIE : le
   * passage au méridien doit tomber dans la journée locale visée. Sinon on
   * décale la sonde d'un jour et on recommence. Trois essais couvrent tous les
   * fuseaux, de UTC−12 à UTC+14. */
  let fallback = null;
  for (const shift of [0, 1, -1]) {
    const probe = new Date(day0.getTime() + (12 + shift * 24) * 3600000);
    const s = sunTimes(probe, lat, lon);
    if (s.transit >= day0.getTime() && s.transit < dayEnd.getTime()) return s;
    fallback ??= s;
  }
  // Aux latitudes polaires il n'y a ni lever ni coucher : on rend le premier
  // essai plutôt que rien, et l'appelant voit des champs nuls comme prévu.
  return fallback;
}

/** Série de `days` jours d'événements solaires, au format attendu par la brique pêche. */
export function sunSeries(fromDate, days, lat, lon) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(fromDate.valueOf() + i * DAY_MS);
    const s = sunTimes(d, lat, lon);
    if (s.sunriseT && s.sunsetT) out.push(s);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Lune
 * ------------------------------------------------------------------------ */

function moonCoords(d) {
  const L = 218.316 + 13.176396 * d; // longitude moyenne
  const M = 134.963 + 13.064993 * d; // anomalie moyenne
  const F = 93.272 + 13.22935 * d;   // argument de latitude

  const lon = L + 6.289 * sin(M);
  const lat = 5.128 * sin(F);
  const distKm = 385001 - 20905 * cos(M);

  return {
    ra: toDeg(Math.atan2(sin(lon) * cos(OBLIQUITY) - Math.tan(toRad(lat)) * sin(OBLIQUITY), cos(lon))),
    dec: toDeg(Math.asin(sin(lat) * cos(OBLIQUITY) + cos(lat) * sin(OBLIQUITY) * sin(lon))),
    distKm,
    lon,
  };
}

const PHASE_NAMES = [
  'Nouvelle lune', 'Premier croissant', 'Premier quartier', 'Lune gibbeuse croissante',
  'Pleine lune', 'Lune gibbeuse décroissante', 'Dernier quartier', 'Dernier croissant',
];

/**
 * Phase, illumination, âge.
 * `phase` ∈ [0,1) : 0 = nouvelle lune, 0.5 = pleine lune.
 */
export function moonPhase(date = new Date()) {
  const d = daysSinceJ2000(date);
  const s = sunCoords(d);
  const m = moonCoords(d);

  const sunDistKm = 149598000;
  const elong = toDeg(
    Math.acos(
      Math.min(1, Math.max(-1, sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra))),
    ),
  );
  const phaseAngle = toDeg(
    Math.atan2(sunDistKm * sin(elong), m.distKm - sunDistKm * cos(elong)),
  );
  const illumination = (1 + cos(phaseAngle)) / 2;

  // L'illumination seule est ambiguë : 50 % vaut aussi bien premier que dernier
  // quartier. L'élongation écliptique lève le doute — la lune est croissante
  // tant qu'elle devance le soleil de moins de 180°.
  const waxing = norm360(m.lon - s.L) < 180;
  const phase = waxing ? illumination / 2 : 1 - illumination / 2;

  return {
    phase,
    illumination,
    waxing,
    ageDays: phase * 29.530588853,
    distKm: m.distKm,
    name: PHASE_NAMES[Math.round(phase * 8) % 8],
    /** Périgée/apogée : marque les marées de vives-eaux exceptionnelles. */
    perigee: m.distKm < 370000,
  };
}

/** Hauteur de la lune (degrés). */
export function moonAltitude(date, lat, lon) {
  const d = daysSinceJ2000(date);
  const m = moonCoords(d);
  const H = norm360(gmst(d) + lon - m.ra);
  const alt = toDeg(Math.asin(sin(lat) * sin(m.dec) + cos(lat) * cos(m.dec) * cos(H)));
  return alt - 0.017 / Math.tan(toRad(alt + 10.26 / (alt + 5.1))); // réfraction
}

/**
 * Lever / coucher / passage au méridien de la lune, par balayage horaire puis
 * dichotomie. Approche brute mais robuste : la lune peut ne pas se lever un
 * jour donné, et les formules fermées gèrent mal ce cas.
 */
export function moonTimes(date, lat, lon) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const t0 = start.valueOf();

  let rise = null;
  let set = null;
  let transit = null;
  let maxAlt = -90;
  let prev = moonAltitude(new Date(t0), lat, lon);

  for (let h = 1; h <= 24; h++) {
    const t = t0 + h * 3600000;
    const cur = moonAltitude(new Date(t), lat, lon);
    if (cur > maxAlt) {
      maxAlt = cur;
      transit = t;
    }
    if (prev < 0 && cur >= 0 && rise === null) rise = refine(t - 3600000, t, lat, lon);
    if (prev >= 0 && cur < 0 && set === null) set = refine(t - 3600000, t, lat, lon);
    prev = cur;
  }
  return { riseT: rise, setT: set, transitT: transit, maxAltitude: maxAlt };
}

function refine(ta, tb, lat, lon) {
  for (let i = 0; i < 20; i++) {
    const tm = (ta + tb) / 2;
    if (moonAltitude(new Date(ta), lat, lon) * moonAltitude(new Date(tm), lat, lon) <= 0) tb = tm;
    else ta = tm;
  }
  return Math.round((ta + tb) / 2);
}

/**
 * Phase lumineuse à un instant donné, pour le scoring pêche.
 * Le crépuscule s'étend de -6° à +6° de hauteur solaire : c'est la définition
 * qui colle au comportement des poissons, pas celle de l'almanach.
 */
export function lightPhaseAt(t, lat, lon) {
  const alt = sunAltitude(new Date(t), lat, lon);
  if (alt < -6) return 'night';
  if (alt < 6) return 'twilight';
  return 'day';
}

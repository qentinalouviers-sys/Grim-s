/* ==========================================================================
 * core/fmt.js — formatage marin
 * --------------------------------------------------------------------------
 * Un affichage de passerelle ne se lit pas comme un tableau de bord web :
 * chiffres tabulaires, unités marines, latitude en degrés-minutes décimales
 * (la seule forme qu'on recopie sans erreur sur une VHF ou un journal papier).
 * ========================================================================== */

export const KN_PER_MS = 1.943844;
export const MS_PER_KN = 0.5144444;

export const msToKn = (ms) => ms * KN_PER_MS;
export const knToMs = (kn) => kn * MS_PER_KN;
export const kmhToKn = (k) => k / 1.852;
export const mToNm = (m) => m / 1852;

const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

/** Nombre avec n décimales, tiret cadratin si absent. */
export function num(v, digits = 1, dash = '—') {
  return Number.isFinite(v) ? v.toFixed(digits) : dash;
}

/** Cap sur 3 chiffres : 007°, 245°. */
export function heading(v) {
  return Number.isFinite(v) ? `${pad(((v % 360) + 360) % 360, 3)}°` : '—––°';
}

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

/* Les mêmes seize secteurs, écrits. « NO » se lit sans hésiter quand on a
 * l'habitude ; « nord-ouest » se lit sans l'avoir. La rose abrégée reste pour
 * les lignes techniques (courant, relèvement, cap), où la place est comptée et
 * où l'abréviation est la convention. */
const CARDINALS_LONG = [
  'nord', 'nord-nord-est', 'nord-est', 'est-nord-est',
  'est', 'est-sud-est', 'sud-est', 'sud-sud-est',
  'sud', 'sud-sud-ouest', 'sud-ouest', 'ouest-sud-ouest',
  'ouest', 'ouest-nord-ouest', 'nord-ouest', 'nord-nord-ouest',
];

const sector = (deg) => Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;

/** Rose 16 secteurs, nomenclature française (O et non W). */
export function cardinal(deg) {
  if (!Number.isFinite(deg)) return '—';
  return CARDINALS[sector(deg)];
}

/** Rose 16 secteurs en toutes lettres : « nord-ouest », « est-sud-est ». */
export function cardinalLong(deg) {
  if (!Number.isFinite(deg)) return '—';
  return CARDINALS_LONG[sector(deg)];
}

/**
 * Le vent, écrit comme on le dit à bord : « vent de nord-ouest ».
 *
 * La direction météo est celle D'OÙ vient le vent — c'est ce que renvoie
 * Open-Meteo (`wind_direction_10m`) et c'est ce que dit la préposition « de ».
 * Le courant, lui, se donne dans le sens où il PORTE : les deux ne s'écrivent
 * donc pas de la même façon, et les confondre inverse une information de
 * sécurité de cent-quatre-vingts degrés.
 */
export function windFrom(deg) {
  if (!Number.isFinite(deg)) return 'vent indisponible';
  const s = CARDINALS_LONG[sector(deg)];
  // Élision. « vent de est-sud-est » ne s'écrit pas et ne se dit pas : six des
  // seize secteurs commencent par une voyelle (est…, ouest…) et prennent d'.
  return `vent d${/^[aeiou]/.test(s) ? '’' : 'e '}${s}`;
}

/** Latitude/longitude en degrés-minutes décimales : 49°55.94'N 001°04.98'E */
export function latDDM(lat) {
  if (!Number.isFinite(lat)) return '—';
  const h = lat >= 0 ? 'N' : 'S';
  const a = Math.abs(lat);
  const d = Math.floor(a);
  return `${pad(d, 2)}°${(a - d) * 60 < 10 ? '0' : ''}${((a - d) * 60).toFixed(2)}'${h}`;
}

export function lonDDM(lon) {
  if (!Number.isFinite(lon)) return '—';
  const h = lon >= 0 ? 'E' : 'W';
  const a = Math.abs(lon);
  const d = Math.floor(a);
  return `${pad(d, 3)}°${(a - d) * 60 < 10 ? '0' : ''}${((a - d) * 60).toFixed(2)}'${h}`;
}

export const posDDM = (p) => (p ? `${latDDM(p.lat)} ${lonDDM(p.lon)}` : '—');

/** Distance : mètres sous 1 NM, milles au-delà. */
export function dist(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1852) return `${Math.round(meters)} m`;
  const nm = meters / 1852;
  return `${nm.toFixed(nm < 10 ? 2 : 1)} NM`;
}

/** Heure locale HH:MM. */
export function hhmm(t) {
  if (!Number.isFinite(t) && !(t instanceof Date)) return '—';
  const d = t instanceof Date ? t : new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Préfixe de jour, vide si c'est aujourd'hui.
 * « 06:19 » pour une fenêtre de demain matin se lit comme aujourd'hui, et
 * c'est le genre de malentendu qui fait rater une marée. Deux fenêtres de
 * jours différents peuvent même sembler se chevaucher.
 */
export function dayPrefix(t, now = Date.now()) {
  const d0 = new Date(now);
  d0.setHours(0, 0, 0, 0);
  const days = Math.floor((t - d0.valueOf()) / 86400000);
  if (days <= 0) return '';
  if (days === 1) return 'demain ';
  if (days < 7) return `${new Date(t).toLocaleDateString('fr-FR', { weekday: 'long' })} `;
  return `${new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} `;
}

/** Heure datée : « 07:19 » aujourd'hui, « demain 06:19 » sinon. */
export const hhmmDay = (t, now = Date.now()) => `${dayPrefix(t, now)}${hhmm(t)}`;

/** Heure locale HH:MM:SS. */
export function hhmmss(t) {
  const d = t instanceof Date ? t : new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Durée compacte : 2 h 05, 47 min, 38 s. */
export function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)}`;
}

/** Durée signée relative : « dans 1 h 20 » / « il y a 12 min ». */
export function relative(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 0 ? `dans ${duration(ms)}` : `il y a ${duration(-ms)}`;
}

/** Compte à rebours HH:MM pour les fenêtres de marée. */
export function countdown(ms) {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  const m = Math.round(Math.abs(ms) / 60000);
  return `${neg ? '−' : '+'}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Âge d'une donnée en cache, pour le bandeau de fraîcheur. */
export function age(t) {
  if (!Number.isFinite(t)) return 'jamais';
  const d = Date.now() - t;
  if (d < 90_000) return "à l'instant";
  if (d < 3600_000) return `${Math.round(d / 60000)} min`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h`;
  return `${Math.round(d / 86400_000)} j`;
}

/** Force Beaufort depuis la vitesse en nœuds. */
export function beaufort(kn) {
  if (!Number.isFinite(kn)) return null;
  const limits = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63];
  let f = 0;
  while (f < limits.length && kn > limits[f]) f++;
  return f;
}

const BEAUFORT_LABEL = [
  'Calme', 'Très légère brise', 'Légère brise', 'Petite brise', 'Jolie brise',
  'Bonne brise', 'Vent frais', 'Grand frais', 'Coup de vent', 'Fort coup de vent',
  'Tempête', 'Violente tempête', 'Ouragan',
];
export const beaufortLabel = (f) => BEAUFORT_LABEL[Math.min(12, Math.max(0, f | 0))];

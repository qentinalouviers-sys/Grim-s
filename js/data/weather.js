/* ==========================================================================
 * data/weather.js — météo et état de la mer (Open-Meteo, sans clé)
 * --------------------------------------------------------------------------
 * Deux endpoints gratuits et sans inscription, fusionnés sur une grille
 * horaire commune :
 *
 *   forecast     vent 10 m, rafales, pression au niveau de la mer, température
 *                de l'air, précipitations, couverture nuageuse, visibilité
 *   marine       hauteur/période/direction de houle et de mer du vent,
 *                température de surface, courant océanique de surface
 *
 * Le courant Open-Meteo tourne à ~8 km de résolution : inexploitable en
 * côtier, où le courant de marée fait 10 fois sa valeur. On le récupère quand
 * même comme composante RÉSIDUELLE (dérive générale, effet du vent au large)
 * qui s'ajoute au courant de marée calculé par data/stream.js.
 *
 * Toute la couche est offline-first (core/net.js) : une réponse est mise en
 * cache et resservie avec son âge. 72 h de prévision en cache pèsent ~40 ko.
 * ========================================================================== */

import * as net from '../core/net.js';
import { kmhToKn } from '../core/fmt.js';

/** Plafond du courant résiduel non-marée retenu, en nœuds. Voir plus bas. */
const RESIDUAL_MAX_KN = 0.5;

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

const FORECAST_VARS = [
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'pressure_msl',
  'temperature_2m',
  'precipitation',
  'cloud_cover',
  'visibility',
].join(',');

const MARINE_VARS = [
  'wave_height',
  'wave_period',
  'wave_direction',
  'wind_wave_height',
  'wind_wave_period',
  'swell_wave_height',
  'swell_wave_period',
  'swell_wave_direction',
  'sea_surface_temperature',
  'ocean_current_velocity',
  'ocean_current_direction',
].join(',');

const q = (base, params) =>
  `${base}?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')}`;

/** Indexe un bloc horaire Open-Meteo par timestamp. */
function indexHourly(hourly) {
  const map = new Map();
  if (!hourly?.time) return map;
  hourly.time.forEach((iso, i) => {
    // Open-Meteo renvoie l'heure locale du fuseau demandé, sans offset.
    map.set(Date.parse(`${iso}:00`), i);
  });
  return map;
}

/**
 * @returns {Promise<{
 *   hourly: {t:number, windSpeedKn:number, windDirDeg:number, windGustKn:number,
 *            pressureHpa:number, airTempC:number, precipMm:number, cloudPct:number,
 *            visibilityM:number, waveHeightM:number, wavePeriodS:number,
 *            waveDirDeg:number, swellHeightM:number, seaTempC:number,
 *            residualCurrent:{dir:number,spd:number}|null}[],
 *   fetchedAt:number, stale:boolean, source:string
 * }>}
 */
/**
 * Sept jours, et pas quatre.
 *
 * Quatre suffisaient pour le scoring : au-delà, une prévision de vent à 96 h ne
 * vaut plus grand-chose pour décider d'une marée précise. Mais ce n'est pas le
 * seul usage — on regarde aussi la semaine pour savoir QUEL JOUR sortir, et
 * cette question-là se pose le lundi pour le week-end. Sept jours, c'est la
 * limite de l'API marine (huit) moins la marge, et l'horizon au-delà duquel
 * l'écran devra dire lui-même que la confiance baisse.
 *
 * Le coût : 168 heures au lieu de 96, soit ~70 ko en cache au lieu de ~40. Une
 * seule connexion au port les télécharge, et ils restent lisibles en mer.
 */
export const FORECAST_DAYS = 7;

export async function load(lat, lon, { days = FORECAST_DAYS, force = false } = {}) {
  const common = {
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    timezone: 'auto',
    forecast_days: days,
  };

  const [f, m] = await Promise.all([
    // `days` fait partie de la clé de cache : sans lui, passer de quatre à sept
    // jours aurait resservi l'ancienne réponse tronquée jusqu'à sa péremption,
    // et l'écran de semaine serait resté à moitié vide sans raison visible.
    net.getJSON(q(FORECAST, { ...common, hourly: FORECAST_VARS }), {
      key: `forecast:${common.latitude},${common.longitude}:${days}`,
      maxAgeMs: force ? 0 : 45 * 60_000,
      timeoutMs: 9000,
      force,
    }),
    net.getJSON(q(MARINE, { ...common, hourly: MARINE_VARS }), {
      key: `marine:${common.latitude},${common.longitude}:${days}`,
      maxAgeMs: force ? 0 : 60 * 60_000,
      timeoutMs: 9000,
      force,
    }),
  ]);

  const fh = f.data?.hourly;
  const mh = m.data?.hourly;
  if (!fh?.time && !mh?.time) {
    return { hourly: [], fetchedAt: 0, stale: true, source: 'none' };
  }

  const base = fh?.time ? fh : mh;
  const mIdx = indexHourly(mh);
  const fIdx = indexHourly(fh);

  const hourly = base.time.map((iso) => {
    const t = Date.parse(`${iso}:00`);
    const i = fIdx.get(t);
    const j = mIdx.get(t);
    const pick = (arr, k) => (arr && k !== undefined && arr[k] != null ? arr[k] : undefined);

    const curSpd = pick(mh?.ocean_current_velocity, j);
    const curDir = pick(mh?.ocean_current_direction, j);

    return {
      t,
      windSpeedKn: kmhToKn(pick(fh?.wind_speed_10m, i) ?? 0),
      windDirDeg: pick(fh?.wind_direction_10m, i) ?? 0,
      windGustKn: kmhToKn(pick(fh?.wind_gusts_10m, i) ?? 0),
      pressureHpa: pick(fh?.pressure_msl, i),
      airTempC: pick(fh?.temperature_2m, i),
      precipMm: pick(fh?.precipitation, i) ?? 0,
      cloudPct: pick(fh?.cloud_cover, i),
      visibilityM: pick(fh?.visibility, i),
      waveHeightM: pick(mh?.wave_height, j),
      wavePeriodS: pick(mh?.wave_period, j),
      waveDirDeg: pick(mh?.wave_direction, j),
      windWaveHeightM: pick(mh?.wind_wave_height, j),
      swellHeightM: pick(mh?.swell_wave_height, j),
      swellPeriodS: pick(mh?.swell_wave_period, j),
      seaTempC: pick(mh?.sea_surface_temperature, j),
      // Courant résiduel non-marée : converti en nœuds, direction VERS.
      //
      // Open-Meteo publie CETTE vitesse en km/h, comme le vent quelques lignes
      // plus haut. Elle était convertie avec le facteur des mètres par seconde
      // (×1,94384) au lieu de celui des kilomètres par heure : 3,6 fois trop.
      // Comme ce résiduel s'additionne au courant de marée dans driftVector(),
      // il dominait la somme — dérive annoncée à 3,8 nd quand le courant de
      // marée en donnait 1,2. Tout ce qui en découle était faux avec lui :
      // trajectoire prévue, point de largage, cône d'incertitude, et la dérive
      // d'un homme à la mer.
      //
      // Et il est PLAFONNÉ, pour une raison qu'il faut assumer plutôt que
      // cacher : ce champ vient d'un modèle océanique global, et rien ne dit
      // s'il inclut ou non la marée. S'il l'inclut, l'ajouter à notre propre
      // courant de marée compte la marée deux fois. Le relevé du 10/08 au nord
      // de Dieppe donnait 0,7 nd de « résiduel » là où le résiduel non-marée
      // de la Manche orientale se tient entre 0,1 et 0,3 nd : la valeur sent le
      // courant de marée déguisé. Faute de pouvoir trancher, on borne à ce que
      // la physique du plateau autorise. Le plafond ne mord jamais sur un vrai
      // résiduel, et limite les dégâts s'il s'agit d'un doublon — ce vecteur
      // sert aussi à prédire la dérive d'un homme à la mer.
      residualCurrent:
        curSpd != null && curDir != null
          ? { dir: curDir, spd: Math.min(RESIDUAL_MAX_KN, kmhToKn(curSpd)) }
          : null,
    };
  });

  return {
    hourly,
    fetchedAt: Math.max(f.fetchedAt, m.fetchedAt),
    stale: f.stale || m.stale,
    source: f.source === 'network' || m.source === 'network' ? 'network' : f.source,
  };
}

/* ==========================================================================
 * Découpage par journée
 * --------------------------------------------------------------------------
 * Open-Meteo publie une série horaire continue. Pour choisir un jour, il faut
 * la couper aux minuits LOCAUX — pas toutes les 24 heures depuis maintenant :
 * « demain » commence à minuit, pas à cette heure-ci demain, et un pêcheur qui
 * regarde samedi veut samedi entier, de 00 h à 23 h.
 *
 * Le passage à l'heure d'été est géré sans y penser : on avance de jour en
 * jour avec setDate(), qui respecte le calendrier local, plutôt qu'en
 * additionnant 86 400 000 ms — ce qui décalerait tout d'une heure deux fois
 * par an, et donc d'une heure de marée.
 * ========================================================================== */

/**
 * @returns {{start:number, end:number, hours:Array, summary:{
 *   windMaxKn:number, windMinKn:number, gustMaxKn:number, windDirDeg:number|null,
 *   waveMaxM:number|null, seaTempC:number|null, airMaxC:number|null,
 *   airMinC:number|null, precipMm:number, cloudPct:number|null }}[]}
 */
export function byDay(hourly, maxDays = FORECAST_DAYS) {
  if (!hourly?.length) return [];
  const days = [];
  const cursor = new Date(hourly[0].t);
  cursor.setHours(0, 0, 0, 0);

  for (let d = 0; d < maxDays; d++) {
    const start = cursor.getTime();
    const nextDay = new Date(start);
    nextDay.setDate(nextDay.getDate() + 1);
    const end = nextDay.getTime();
    const hours = hourly.filter((h) => h.t >= start && h.t < end);
    // Une journée sans aucune heure signifie qu'on est au bout de la série :
    // rien à afficher, et surtout pas une carte vide qui ferait croire à une
    // panne. On s'arrête.
    if (!hours.length) break;
    days.push({ start, end, hours, summary: summarize(hours) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** Agrégats d'une journée. `null` quand la donnée manque — jamais zéro. */
function summarize(hours) {
  const nums = (k) => hours.map((h) => h[k]).filter((v) => typeof v === 'number');
  const max = (k) => (nums(k).length ? Math.max(...nums(k)) : null);
  const min = (k) => (nums(k).length ? Math.min(...nums(k)) : null);
  const avg = (k) => (nums(k).length ? nums(k).reduce((a, b) => a + b, 0) / nums(k).length : null);

  /* Direction dominante : moyenne VECTORIELLE, pas arithmétique. Une journée de
   * vent de nord oscillant entre 350° et 10° donnerait 180° — plein sud, soit
   * l'exact opposé — si on faisait la moyenne des nombres. On pondère par la
   * vitesse : l'heure où il souffle à 25 nd pèse plus que celle à 3 nd, ce qui
   * est bien la direction qu'on veut retenir de la journée. */
  let sx = 0;
  let sy = 0;
  for (const h of hours) {
    if (typeof h.windDirDeg !== 'number') continue;
    const w = h.windSpeedKn ?? 1;
    const r = (h.windDirDeg * Math.PI) / 180;
    sx += Math.sin(r) * w;
    sy += Math.cos(r) * w;
  }
  const windDirDeg = sx || sy ? (Math.atan2(sx, sy) * 180) / Math.PI : null;

  return {
    windMaxKn: max('windSpeedKn'),
    windMinKn: min('windSpeedKn'),
    gustMaxKn: max('windGustKn'),
    windDirDeg: windDirDeg == null ? null : (windDirDeg + 360) % 360,
    waveMaxM: max('waveHeightM'),
    seaTempC: avg('seaTempC'),
    airMaxC: max('airTempC'),
    airMinC: min('airTempC'),
    precipMm: hours.reduce((a, h) => a + (h.precipMm || 0), 0),
    cloudPct: avg('cloudPct'),
  };
}

/**
 * La confiance décroît avec l'échéance, et l'écran doit le dire. Ce ne sont pas
 * des pourcentages inventés : c'est l'ordre de grandeur admis pour les modèles
 * globaux dont Open-Meteo tire ses données — bon à 48 h, utilisable à 4 jours,
 * indicatif au-delà. Une prévision de vent à 7 jours sert à choisir un
 * week-end, pas à décider d'une sortie.
 */
export function confidence(dayStart, now = Date.now()) {
  const h = (dayStart - now) / 3600000;
  if (h < 48) return { level: 'high', label: 'fiable' };
  if (h < 96) return { level: 'fair', label: 'à confirmer' };
  return { level: 'low', label: 'tendance seulement' };
}

/** Point horaire le plus proche de t. */
export function at(hourly, t) {
  if (!hourly?.length) return null;
  let best = hourly[0];
  let bestD = Math.abs(best.t - t);
  for (const h of hourly) {
    const d = Math.abs(h.t - t);
    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return bestD < 3 * 3600000 ? best : null;
}

/** Interpolation linéaire entre deux heures — évite les sauts sur les jauges. */
export function interp(hourly, t) {
  if (!hourly?.length) return null;
  if (t <= hourly[0].t) return hourly[0];
  if (t >= hourly[hourly.length - 1].t) return hourly[hourly.length - 1];
  for (let i = 1; i < hourly.length; i++) {
    if (hourly[i].t < t) continue;
    const a = hourly[i - 1];
    const b = hourly[i];
    const f = (t - a.t) / (b.t - a.t);
    const out = { t };
    for (const k of Object.keys(a)) {
      if (k === 't') continue;
      const va = a[k];
      const vb = b[k];
      if (typeof va === 'number' && typeof vb === 'number') {
        out[k] = k.endsWith('DirDeg')
          ? va + (((vb - va + 540) % 360) - 180) * f // interpolation angulaire
          : va + (vb - va) * f;
      } else {
        out[k] = f < 0.5 ? va : vb;
      }
    }
    return out;
  }
  return hourly[hourly.length - 1];
}

/** Tendance barométrique sur 6 h (hPa) — le facteur pression du scoring. */
export function pressureTrend6h(hourly, t) {
  const now = at(hourly, t);
  const past = at(hourly, t - 6 * 3600000);
  if (!now || !past || now.pressureHpa == null || past.pressureHpa == null) return undefined;
  return now.pressureHpa - past.pressureHpa;
}

/**
 * Indice de turbidité 0..1 — proxy d'eau troublée.
 * La clarté de l'eau conditionne le choix du leurre et l'activité des
 * carnassiers à vue (bar, lieu). Personne ne la publie en côtier : on
 * l'estime par l'énergie de mer accumulée sur 18 h, pondérée par le
 * coefficient (les vives-eaux remettent le sédiment en suspension).
 */
export function turbidity(hourly, t, coefficient = 70) {
  if (!hourly?.length) return null;
  const win = hourly.filter((h) => h.t <= t && h.t >= t - 18 * 3600000);
  if (!win.length) return null;
  const energy =
    win.reduce((acc, h) => acc + (h.waveHeightM ?? 0) ** 2 + (h.windSpeedKn ?? 0) / 40, 0) / win.length;
  const coefFactor = 0.6 + 0.4 * Math.min(1, coefficient / 95);
  return Math.max(0, Math.min(1, (energy / 2.2) * coefFactor));
}

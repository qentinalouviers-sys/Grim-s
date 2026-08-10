/* ==========================================================================
 * data/stream.js — courant de marée et dérive prédictive
 * --------------------------------------------------------------------------
 * Le cœur du mode CARTE, et la partie où l'app se distingue vraiment.
 *
 * ── POURQUOI PAS UN MODÈLE DE COURANT TÉLÉCHARGÉ ──────────────────────────
 * Copernicus et Open-Meteo tournent à ~8 km de maille. En côtier, le courant
 * de marée atteint 3 nœuds là où leur résiduelle en donne 0,2. Utiliser leur
 * grille pour prédire une dérive à Dieppe, c'est se tromper d'un facteur dix.
 *
 * ── CE QU'ON FAIT À LA PLACE ──────────────────────────────────────────────
 * La courbe de marée contient déjà l'information. En régime d'onde
 * progressive, le débit — donc la vitesse du courant — est proportionnel à
 * dh/dt. On écrit directement :
 *
 *     vitesse (nœuds) = k · |dh/dt|  ·  facteurLocal(position)
 *
 * avec k en nœuds par (m/h). Point important : on utilise dh/dt BRUT, pas
 * normalisé sur la fenêtre. Un dh/dt brut porte déjà l'amplitude vive-eau /
 * morte-eau. Le modèle de référence normalisait par le maximum de la fenêtre
 * PUIS multipliait par (coef / coefRef) : c'est la même correction appliquée
 * deux fois, et ça surestime les vives-eaux d'environ 40 %.
 *
 * La DIRECTION vient de l'axe du courant, qui est quasi rectiligne au large
 * de Dieppe : le flot porte à l'ENE le long de la côte, le jusant à l'OSO.
 * On fait tourner l'axe en douceur autour de l'étale plutôt que de le faire
 * basculer d'un coup — un renverse réel prend vingt minutes à s'établir.
 *
 * ── HONNÊTETÉ DU MODÈLE ───────────────────────────────────────────────────
 * Trois paramètres sont incertains : k, le déphasage étale-hauteur / étale-
 * courant, et l'axe. TOUS LES TROIS SONT AJUSTABLES sur les relevés GPS de
 * l'utilisateur (calibrate() plus bas). Dès une vingtaine de dérives moteur
 * coupé enregistrées, le modèle devient propre à SON bateau et à SES spots.
 * C'est la vraie boucle d'apprentissage de l'app : pas un modèle générique,
 * un modèle calibré.
 *
 * L'incertitude est retournée avec la prédiction (`confidence`) et l'UI trace
 * un cône, pas une ligne. Une dérive prédite affichée comme un trait fin est
 * un mensonge graphique.
 * ========================================================================== */

import {
  norm360, lerpAngle, addVectors, offsetMeters, vecToEN,
  distance, toRad, meanAngle, M_PER_NM,
} from '../core/geo.js';
import * as tide from './tide.js';
import * as weather from './weather.js';

const HOUR = 3600000;
const MIN = 60000;

/**
 * Réglages du modèle. Valeurs par défaut = « bateau de pêche open 6 m,
 * secteur Dieppe ». Tout est écrasé par la calibration utilisateur.
 */
export const DEFAULTS = {
  /** Nœuds de courant par mètre-par-heure de variation de hauteur. */
  knPerMPerHour: 1.15,
  /** Direction VERS laquelle porte le flot (montant), en degrés vrais. */
  floodAxisDeg: 62,
  /** Direction VERS laquelle porte le jusant (descendant). */
  ebbAxisDeg: 242,
  /**
   * Déphasage étale de hauteur → étale de courant, en minutes.
   * Positif = le courant renverse APRÈS la PM/BM. En Manche il n'est pas nul,
   * mais sa valeur locale ne se devine pas : elle se mesure. Défaut 0, et
   * l'UI signale que ce paramètre n'est pas calé tant que calibrate()
   * n'a pas tourné.
   */
  slackLagMin: 0,
  /** Durée de la rotation d'axe autour de l'étale, en minutes. */
  turnDurationMin: 40,
  /** Dérive due au vent, en % de la vitesse du vent vrai. */
  leewayPct: 3.5,
  /** Angle de dérive par rapport au lit du vent (bateau en travers). */
  leewayAngleDeg: 0,
  /** Incertitude de base sur la vitesse de courant, en % (avant calibration). */
  uncertaintyPct: 35,
  calibrated: false,
  observations: 0,
};

let cfg = { ...DEFAULTS };

export const config = () => ({ ...cfg });
export function setConfig(patch) {
  cfg = { ...cfg, ...patch };
  return config();
}

/* --------------------------------------------------------------------------
 * Facteur local
 * --------------------------------------------------------------------------
 * Le courant n'est pas uniforme : il accélère au large et sur les hauts-fonds,
 * il faiblit dans l'ombre des jetées. On interpole quelques nœuds documentés
 * en pondération inverse de la distance. Une carte de courant fine n'existe
 * pas gratuitement — mais trois multiplicateurs valent mieux qu'un seul.
 * ------------------------------------------------------------------------ */
let streamNodes = [];

export function setStreamNodes(nodes) {
  streamNodes = Array.isArray(nodes) ? nodes : [];
}

// Le profil de 24 h interroge 96 fois la MÊME position : on garde le dernier
// résultat. La grille de vecteurs, elle, change de position à chaque point et
// n'en profite pas — c'est sans importance, le calcul y est court.
let lfCache = null;

/** @returns {{factor:number, axisBias:number}} */
export function localFactor(pos) {
  if (!pos || !streamNodes.length) return { factor: 1, axisBias: 0 };
  if (lfCache && Math.abs(lfCache.lat - pos.lat) < 2e-4 && Math.abs(lfCache.lon - pos.lon) < 3e-4) {
    return lfCache.val;
  }
  let wSum = 0;
  let fSum = 0;
  let bSum = 0;
  for (const n of streamNodes) {
    const d = Math.max(300, distance(pos, n));
    const w = 1 / (d * d);
    wSum += w;
    fSum += w * (n.factor ?? 1);
    bSum += w * (n.axisBias ?? 0);
  }
  const val = { factor: fSum / wSum, axisBias: bSum / wSum };
  lfCache = { lat: pos.lat, lon: pos.lon, val };
  return val;
}

/* --------------------------------------------------------------------------
 * Vecteur courant de marée
 * ------------------------------------------------------------------------ */

/**
 * Courant de marée à un instant et une position.
 * @returns {{dir:number, spd:number, sense:'flood'|'ebb'|'slack',
 *            rateMPerH:number, hoursToSlack:number, confidence:number}}
 */
export function tidalStream(t, pos = null) {
  // Le courant à l'instant t répond à la hauteur décalée du déphasage.
  const tEff = t - cfg.slackLagMin * MIN;
  const rateMPerH = tide.rate(tEff);
  const local = localFactor(pos);

  const spd = Math.abs(rateMPerH) * cfg.knPerMPerHour * local.factor;

  // Étale la plus proche, en heures — l'axe tourne autour d'elle.
  const ext = tide.extrema(tEff - 8 * HOUR, tEff + 8 * HOUR);
  let hoursToSlack = 6;
  let nearestT = tEff;
  for (const e of ext) {
    const dh = Math.abs(e.t - tEff) / HOUR;
    if (dh < hoursToSlack) {
      hoursToSlack = dh;
      nearestT = e.t;
    }
  }

  const flood = norm360(cfg.floodAxisDeg + local.axisBias);
  const ebb = norm360(cfg.ebbAxisDeg + local.axisBias);
  // Le signe de dh/dt donne le régime EN COURS : avant l'étale c'est encore
  // l'ancien, après c'est déjà le nouveau.
  const running = rateMPerH >= 0 ? flood : ebb;
  const other = rateMPerH >= 0 ? ebb : flood;

  // Rotation continue autour de l'étale : à l'instant exact du renverse on est
  // à mi-chemin entre les deux axes — et le vecteur y est de toute façon nul.
  const half = cfg.turnDurationMin / 2 / 60;
  const signed = (tEff - nearestT) / HOUR; // < 0 avant l'étale
  let dir = running;
  if (hoursToSlack < half) {
    dir =
      signed >= 0
        ? lerpAngle(other, running, 0.5 * (1 + signed / half)) // ancien → nouveau
        : lerpAngle(running, other, 0.5 * (1 - hoursToSlack / half)); // ancien → milieu
  }

  const sense = spd < 0.15 ? 'slack' : rateMPerH >= 0 ? 'flood' : 'ebb';

  return {
    dir: norm360(dir),
    spd,
    sense,
    rateMPerH,
    hoursToSlack,
    hoursFromSlack: signed,
    slackT: nearestT + cfg.slackLagMin * MIN,
    confidence: cfg.calibrated ? 0.8 : 0.5,
  };
}

/**
 * Dérive totale d'un bateau moteur coupé : courant de marée + dérive au vent
 * + résiduelle océanique. C'est ce vecteur, et pas le courant seul, qui décrit
 * ce que fait vraiment le bateau.
 */
export function driftVector(t, pos, wx = null) {
  const stream = tidalStream(t, pos);
  const parts = [{ dir: stream.dir, spd: stream.spd }];

  let leeway = null;
  if (wx && Number.isFinite(wx.windSpeedKn)) {
    // Le vent vient DE windDirDeg : la dérive porte vers +180°.
    leeway = {
      dir: norm360(wx.windDirDeg + 180 + cfg.leewayAngleDeg),
      spd: (wx.windSpeedKn * cfg.leewayPct) / 100,
    };
    parts.push(leeway);
  }
  if (wx?.residualCurrent) parts.push(wx.residualCurrent);

  const total = addVectors(...parts);
  return { ...total, stream, leeway, residual: wx?.residualCurrent || null, sense: stream.sense };
}

/* --------------------------------------------------------------------------
 * Intégration de trajectoire
 * ------------------------------------------------------------------------ */

/**
 * Trajectoire de dérive prévue.
 *
 * @param {{lat,lon}} start
 * @param {number} startT
 * @param {number} minutes    durée (négative = remonter le temps)
 * @param {object[]} hourly   météo horaire (peut être vide)
 * @param {{stepMin?:number}} [opts]
 * @returns {{points:{lat,lon,t,vec}[], distanceM:number, meanVec:{dir,spd},
 *            spreadM:number, uncertainty:number}}
 */
export function predictDrift(start, startT, minutes, hourly = [], opts = {}) {
  const stepMin = opts.stepMin ?? 2;
  const sign = Math.sign(minutes) || 1;
  const steps = Math.max(1, Math.round(Math.abs(minutes) / stepMin));
  const dtMs = sign * stepMin * MIN;

  let pos = { ...start };
  let t = startT;
  const points = [{ lat: pos.lat, lon: pos.lon, t, vec: null }];
  const dirs = [];
  const spds = [];

  for (let i = 0; i < steps; i++) {
    const wx = hourly.length ? weather.interp(hourly, t) : null;

    // Heun (prédicteur-correcteur) : deux évaluations par pas. Sur 90 min de
    // dérive, l'écart avec un Euler simple atteint 60 m près du renverse,
    // là où le vecteur tourne vite. C'est exactement le moment qui intéresse.
    const v1 = driftVector(t, pos, wx);
    const p1 = advance(pos, v1, dtMs);
    const v2 = driftVector(t + dtMs, p1, hourly.length ? weather.interp(hourly, t + dtMs) : wx);
    const mean = addVectors({ dir: v1.dir, spd: v1.spd / 2 }, { dir: v2.dir, spd: v2.spd / 2 });

    pos = advance(pos, mean, dtMs);
    t += dtMs;
    dirs.push(mean.dir);
    spds.push(mean.spd);
    points.push({ lat: pos.lat, lon: pos.lon, t, vec: mean });
  }

  const distanceM = distance(start, pos);
  const meanSpd = spds.reduce((a, b) => a + b, 0) / (spds.length || 1);

  // Incertitude : elle croît en √t (erreur de vitesse intégrée) et non
  // linéairement — les erreurs de courant se compensent partiellement d'un
  // pas à l'autre. Plancher de 25 m pour la précision GPS.
  const pct = cfg.calibrated ? cfg.uncertaintyPct * 0.5 : cfg.uncertaintyPct;
  const hours = Math.abs(minutes) / 60;
  const spreadM = Math.max(25, meanSpd * M_PER_NM * Math.sqrt(hours) * (pct / 100));

  return {
    points,
    distanceM,
    meanVec: { dir: meanAngle(dirs, spds), spd: meanSpd },
    spreadM,
    uncertainty: pct / 100,
    endT: t,
  };
}

function advance(pos, vec, dtMs) {
  const { east, north } = vecToEN(vec); // nœuds
  const seconds = dtMs / 1000;
  return offsetMeters(pos, (east * M_PER_NM * seconds) / 3600, (north * M_PER_NM * seconds) / 3600);
}

/**
 * Point de largage : où se mettre à l'eau pour que la dérive passe sur la
 * cible. On remonte le temps depuis la cible — la trajectoire de dérive
 * n'étant pas réversible exactement (le vecteur dépend de la position), on
 * itère trois fois sur le point de départ jusqu'à convergence.
 *
 * @param {{lat,lon}} target  le point qu'on veut survoler
 * @param {number} arriveT    instant de passage voulu
 * @param {number} leadMin    combien de minutes de dérive avant la cible
 */
export function dropPoint(target, arriveT, leadMin, hourly = []) {
  let guess = predictDrift(target, arriveT, -leadMin, hourly).points.at(-1);
  for (let i = 0; i < 3; i++) {
    const fwd = predictDrift(guess, arriveT - leadMin * MIN, leadMin, hourly);
    const end = fwd.points.at(-1);
    const errE = -(end.lon - target.lon) * 111320 * Math.cos(toRad(target.lat));
    const errN = -(end.lat - target.lat) * 110540;
    guess = offsetMeters(guess, errE, errN);
    if (Math.hypot(errE, errN) < 10) break;
  }
  const track = predictDrift(guess, arriveT - leadMin * MIN, leadMin, hourly);
  return { drop: { lat: guess.lat, lon: guess.lon }, startT: arriveT - leadMin * MIN, track };
}

/**
 * Cône d'incertitude autour d'une trajectoire — polygone fermé prêt pour
 * Leaflet. La largeur croît le long de la dérive.
 */
export function uncertaintyCone(track) {
  if (track.points.length < 2) return [];
  const left = [];
  const right = [];
  const n = track.points.length;
  track.points.forEach((p, i) => {
    const f = i / (n - 1);
    const w = Math.max(20, track.spreadM * f);
    const v = p.vec || track.meanVec;
    const perp = toRad(v.dir + 90);
    const dE = Math.sin(perp) * w;
    const dN = Math.cos(perp) * w;
    left.push(offsetMeters(p, dE, dN));
    right.push(offsetMeters(p, -dE, -dN));
  });
  return [...left, ...right.reverse()];
}

/* --------------------------------------------------------------------------
 * Calibration sur relevés GPS
 * ------------------------------------------------------------------------ */

/**
 * Ajuste le modèle sur des dérives réellement observées (moteur coupé).
 *
 * Trois paramètres, trois méthodes adaptées à leur nature :
 *   • k          moindres carrés à un paramètre → solution fermée
 *   • axes       moyenne circulaire des directions observées, séparément
 *                flot et jusant
 *   • déphasage  balayage sur ±90 min, on garde le minimum de résidu ; c'est
 *                un paramètre unidimensionnel borné, une recherche exhaustive
 *                bat n'importe quel optimiseur en 2 lignes
 *
 * On retire la composante de dérive au vent AVANT l'ajustement, sans quoi on
 * attribuerait au courant ce que fait le fardage.
 *
 * @param {{t:number, lat:number, lon:number, dirDeg:number, spdKn:number,
 *          windSpeedKn?:number, windDirDeg?:number}[]} obs
 */
export function calibrate(obs, base = cfg) {
  const usable = obs.filter((o) => Number.isFinite(o.spdKn) && Number.isFinite(o.dirDeg) && o.spdKn < 8);
  if (usable.length < 5) {
    return { ...base, calibrated: false, observations: usable.length, reason: 'trop peu de relevés' };
  }

  // 1. Dérive courant seule = dérive observée − dérive au vent estimée.
  const stripped = usable.map((o) => {
    let v = { dir: o.dirDeg, spd: o.spdKn };
    if (Number.isFinite(o.windSpeedKn) && Number.isFinite(o.windDirDeg)) {
      v = addVectors(v, {
        dir: norm360(o.windDirDeg + 180 + base.leewayAngleDeg),
        spd: -(o.windSpeedKn * base.leewayPct) / 100,
      });
    }
    return { ...o, cur: v };
  });

  // 2. Axes : moyennes circulaires séparées.
  const floods = stripped.filter((o) => tide.rate(o.t - base.slackLagMin * MIN) >= 0 && o.cur.spd > 0.3);
  const ebbs = stripped.filter((o) => tide.rate(o.t - base.slackLagMin * MIN) < 0 && o.cur.spd > 0.3);
  const floodAxisDeg = floods.length >= 3
    ? Math.round(meanAngle(floods.map((o) => o.cur.dir), floods.map((o) => o.cur.spd)))
    : base.floodAxisDeg;
  const ebbAxisDeg = ebbs.length >= 3
    ? Math.round(meanAngle(ebbs.map((o) => o.cur.dir), ebbs.map((o) => o.cur.spd)))
    : base.ebbAxisDeg;

  // 3. Balayage du déphasage, k recalculé en fermé pour chaque essai.
  let best = { lag: base.slackLagMin, k: base.knPerMPerHour, rss: Infinity };
  for (let lag = -90; lag <= 90; lag += 5) {
    let num = 0;
    let den = 0;
    for (const o of stripped) {
      const x = Math.abs(tide.rate(o.t - lag * MIN)) * localFactor(o).factor;
      num += x * o.cur.spd;
      den += x * x;
    }
    if (den === 0) continue;
    const k = num / den;
    let rss = 0;
    for (const o of stripped) {
      const pred = k * Math.abs(tide.rate(o.t - lag * MIN)) * localFactor(o).factor;
      rss += (pred - o.cur.spd) ** 2;
    }
    if (rss < best.rss) best = { lag, k, rss };
  }

  const rms = Math.sqrt(best.rss / stripped.length);
  // Incertitude résiduelle rapportée à la vitesse moyenne observée.
  const meanObs = stripped.reduce((a, o) => a + o.cur.spd, 0) / stripped.length;
  const uncertaintyPct = Math.max(10, Math.min(60, Math.round((rms / Math.max(0.3, meanObs)) * 100)));

  return {
    ...base,
    knPerMPerHour: Number(best.k.toFixed(3)),
    slackLagMin: best.lag,
    floodAxisDeg,
    ebbAxisDeg,
    uncertaintyPct,
    calibrated: true,
    observations: usable.length,
    rmsKn: Number(rms.toFixed(2)),
  };
}

/**
 * Grille de vecteurs pour l'affichage carte. Échantillonne un rectangle et
 * renvoie un vecteur par nœud — l'UI en fait des flèches.
 */
export function vectorField(bounds, t, cols = 7, rows = 7, hourly = []) {
  const out = [];
  const wx = hourly.length ? weather.interp(hourly, t) : null;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const lat = bounds.south + ((bounds.north - bounds.south) * (i + 0.5)) / rows;
      const lon = bounds.west + ((bounds.east - bounds.west) * (j + 0.5)) / cols;
      const v = driftVector(t, { lat, lon }, wx);
      out.push({ lat, lon, dir: v.dir, spd: v.spd, sense: v.sense });
    }
  }
  return out;
}

/** Profil de courant sur 24 h — la courbe du bas de l'écran NAV. */
export function dailyProfile(t0, hours = 24, stepMin = 15, pos = null) {
  const out = [];
  for (let i = 0; i <= (hours * 60) / stepMin; i++) {
    const t = t0 + i * stepMin * MIN;
    const s = tidalStream(t, pos);
    out.push({ t, spd: s.spd, dir: s.dir, sense: s.sense });
  }
  return out;
}

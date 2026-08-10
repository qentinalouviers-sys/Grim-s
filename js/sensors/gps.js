/* ==========================================================================
 * sensors/gps.js — position, vitesse fond, route fond
 * --------------------------------------------------------------------------
 * Le GPS d'un téléphone n'est pas un GPS de passerelle. Trois défauts à
 * corriger avant d'afficher quoi que ce soit :
 *
 * 1. `speed` et `heading` sont souvent null (Safari les omet à l'arrêt, et
 *    certains Android ne les remplissent jamais). On les recalcule par
 *    différence de position.
 * 2. À moins de 0,5 nœud, la route fond est du bruit pur : elle tourne à
 *    360°/s. On la gèle sous un seuil plutôt que d'afficher un compas fou.
 * 3. Le bruit de position fait sauter la vitesse de ±1,5 nœud d'un fix à
 *    l'autre. Filtre alpha-beta adaptatif : on suit vite quand l'accélération
 *    est réelle, on lisse fort quand ce n'est que du bruit.
 *
 * La distance parcourue n'intègre QUE les déplacements supérieurs à
 * l'incertitude du fix, sinon un bateau au mouillage « parcourt » 4 milles
 * dans la nuit.
 * ========================================================================== */

import { set, state, emit } from '../core/store.js';
import { distance, bearing, meanAngle } from '../core/geo.js';
import { msToKn } from '../core/fmt.js';

const MIN_SPEED_FOR_COG = 0.6; // nœuds

let watchId = null;
let last = null;
let speedFilter = null;
const cogHistory = [];

/** État de la permission, sans la demander. */
export async function permissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    return 'unknown';
  }
}

/**
 * Un premier getCurrentPosition force la popup système AVANT de lancer le
 * watch. Sur iOS, démarrer directement par watchPosition donne parfois un
 * silence de 30 s sans dialogue.
 */
export function prime() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        handle(p);
        resolve(true);
      },
      () => resolve(false),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

export function start() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(handle, onError, {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 1000,
  });
}

export function stop() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function onError(err) {
  emit('gps:error', err);
  if (err.code === err.PERMISSION_DENIED) set({ fix: null });
}

function handle(p) {
  const c = p.coords;
  const t = p.timestamp || Date.now();
  const pos = { lat: c.latitude, lon: c.longitude };

  let speedKn = Number.isFinite(c.speed) && c.speed >= 0 ? msToKn(c.speed) : null;
  let cog = Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : null;

  if (last) {
    const dt = (t - last.t) / 1000;
    const d = distance(last.pos, pos);
    if (dt > 0.4 && dt < 30) {
      const derived = msToKn(d / dt);
      if (speedKn == null) speedKn = derived;
      // Un saut de position supérieur au double de l'incertitude combinée
      // est un saut de calcul, pas un mouvement : on ignore la vitesse dérivée.
      const noise = (c.accuracy || 20) + (last.acc || 20);
      if (cog == null && d > noise * 0.8) cog = bearing(last.pos, pos);
    }
  }

  // Filtre alpha adaptatif sur la vitesse.
  if (speedKn != null) {
    if (speedFilter == null) speedFilter = speedKn;
    else {
      const delta = Math.abs(speedKn - speedFilter);
      const alpha = delta > 2 ? 0.6 : delta > 0.8 ? 0.35 : 0.15;
      speedFilter += alpha * (speedKn - speedFilter);
    }
    speedKn = Math.max(0, speedFilter);
  }

  // Lissage circulaire de la route fond sur 5 fixes, uniquement en mouvement.
  let cogSmooth = state.fix?.cogDeg ?? null;
  if (cog != null && speedKn != null && speedKn >= MIN_SPEED_FOR_COG) {
    cogHistory.push(cog);
    if (cogHistory.length > 5) cogHistory.shift();
    cogSmooth = meanAngle(cogHistory);
  } else if (speedKn != null && speedKn < MIN_SPEED_FOR_COG) {
    cogHistory.length = 0;
  }

  const fix = {
    lat: pos.lat,
    lon: pos.lon,
    accuracy: c.accuracy,
    altitude: c.altitude,
    speedKn,
    cogDeg: cogSmooth,
    moving: (speedKn ?? 0) >= MIN_SPEED_FOR_COG,
    t,
  };

  accumulate(fix, last);
  last = { pos, t, acc: c.accuracy };
  set({ fix, fixAge: t });
  emit('gps:fix', fix);
}

/* --------------------------------------------------------------------------
 * Trace et totalisateur
 * ------------------------------------------------------------------------ */
export const track = []; // points de la sortie en cours

function accumulate(fix, prev) {
  if (!state.trip) return;
  if (prev) {
    const d = distance(prev.pos, { lat: fix.lat, lon: fix.lon });
    const noise = Math.max(8, (fix.accuracy || 20) * 0.7);
    if (d > noise) {
      state.trip.distanceM += d;
      track.push({ lat: fix.lat, lon: fix.lon, t: fix.t, speedKn: fix.speedKn });
    }
  } else {
    track.push({ lat: fix.lat, lon: fix.lon, t: fix.t, speedKn: fix.speedKn });
  }
  if ((fix.speedKn ?? 0) > (state.trip.maxSpeedKn ?? 0)) state.trip.maxSpeedKn = fix.speedKn;
  checkAnchor(fix);
}

export function startTrip() {
  track.length = 0;
  set({ trip: { startedAt: Date.now(), distanceM: 0, maxSpeedKn: 0 } });
}

export function stopTrip() {
  const trip = state.trip ? { ...state.trip, endedAt: Date.now(), points: [...track] } : null;
  set({ trip: null });
  return trip;
}

/* --------------------------------------------------------------------------
 * Veille de mouillage
 * --------------------------------------------------------------------------
 * On dérape rarement d'un coup : on part en biais, doucement, pendant que
 * tout le monde pêche. Deux fixes consécutifs hors du cercle déclenchent —
 * un seul serait un faux positif à chaque perte de satellites.
 * ------------------------------------------------------------------------ */
let outsideCount = 0;

function checkAnchor(fix) {
  const a = state.anchor;
  if (!a?.armed) {
    outsideCount = 0;
    return;
  }
  const d = distance(a, fix);
  if (d > a.radiusM + (fix.accuracy || 15)) {
    outsideCount += 1;
    if (outsideCount >= 2) emit('alarm', { kind: 'anchor', distanceM: d, radiusM: a.radiusM });
  } else {
    outsideCount = 0;
  }
}

export function dropAnchor(radiusM = 50) {
  if (!state.fix) return null;
  const a = { lat: state.fix.lat, lon: state.fix.lon, radiusM, armed: true, at: Date.now() };
  set({ anchor: a });
  return a;
}

export function weighAnchor() {
  outsideCount = 0;
  set({ anchor: null });
}

/** Homme à la mer : fige la position et l'heure. Le geste doit être unique. */
export function markMOB() {
  if (!state.fix) return null;
  const m = { lat: state.fix.lat, lon: state.fix.lon, t: Date.now() };
  set({ mob: m });
  emit('alarm', { kind: 'mob', ...m });
  return m;
}

export const clearMOB = () => set({ mob: null });

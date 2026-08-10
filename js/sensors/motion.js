/* ==========================================================================
 * sensors/motion.js — état de la mer par l'accéléromètre
 * --------------------------------------------------------------------------
 * Idée : le téléphone posé dans le bateau EST une bouée houlographe. On
 * intègre deux fois l'accélération verticale et on obtient le mouvement de
 * pilonnement. Le modèle Open-Meteo donne la houle d'une maille de 8 km ;
 * ça, c'est la mer sous la coque, à l'instant présent.
 *
 * Méthode, volontairement simple et robuste :
 *   • on retire la gravité par un passe-haut sur la norme de l'accélération
 *     (pas d'orientation nécessaire, donc pas de dépendance au compas) ;
 *   • on compte les passages par zéro pour la période dominante ;
 *   • on estime la hauteur crête-à-creux par a_max / ω², relation valable
 *     pour un mouvement quasi sinusoïdal — ce qu'est la houle à 80 % ;
 *   • Hs ≈ 1,4 × hauteur moyenne crête-à-creux, approximation de Rayleigh.
 *
 * PRÉCISION : ordre de grandeur, pas mesure. Un téléphone qui glisse sur un
 * banc pollue tout. La valeur est donc affichée comme « ressenti bord »,
 * jamais comme une hauteur significative certifiée, et sert surtout à deux
 * choses utiles : détecter que ça forcit (tendance), et alimenter le facteur
 * de confort du scoring pêche — dériver dans 1,5 m de clapot court, c'est
 * pêcher mal quelle que soit la marée.
 * ========================================================================== */

import { set, emit } from '../core/store.js';

const G = 9.80665;
const BUFFER_SECONDS = 45;

let listening = false;
let samples = []; // { t, a } accélération verticale filtrée
let gravityEst = G;
let lastCrossing = null;
const periods = [];
let peakToPeak = [];
let analyseTimer = 0;

export const supported = () => typeof DeviceMotionEvent !== 'undefined';
export const needsPermission = () =>
  typeof DeviceMotionEvent !== 'undefined' &&
  typeof DeviceMotionEvent.requestPermission === 'function';

export async function requestPermission() {
  if (!supported()) return 'unsupported';
  if (!needsPermission()) {
    start();
    return 'implicit';
  }
  try {
    const res = await DeviceMotionEvent.requestPermission();
    if (res === 'granted') start();
    return res;
  } catch {
    return 'denied';
  }
}

export function start() {
  if (listening || !supported()) return;
  listening = true;
  window.addEventListener('devicemotion', onMotion, { passive: true });
  analyseTimer = setInterval(analyse, 5000);
}

export function stop() {
  if (!listening) return;
  window.removeEventListener('devicemotion', onMotion);
  clearInterval(analyseTimer);
  listening = false;
  samples = [];
  periods.length = 0;
  peakToPeak = [];
}

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const norm = Math.hypot(g.x, g.y, g.z);

  // Passe-haut : la gravité est la seule composante vraiment continue.
  gravityEst += 0.002 * (norm - gravityEst);
  const a = norm - gravityEst;

  const t = e.timeStamp || performance.now();
  samples.push({ t, a });

  // Passages par zéro montants → demi-périodes.
  const n = samples.length;
  if (n > 2) {
    const prev = samples[n - 2];
    if (prev.a < 0 && a >= 0) {
      if (lastCrossing) {
        const p = (t - lastCrossing) / 1000;
        if (p > 1.2 && p < 20) {
          periods.push(p);
          if (periods.length > 40) periods.shift();
        }
      }
      lastCrossing = t;
    }
  }

  const cutoff = t - BUFFER_SECONDS * 1000;
  while (samples.length && samples[0].t < cutoff) samples.shift();
}

function analyse() {
  if (samples.length < 60) return;

  const values = samples.map((s) => s.a);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const rms = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);

  const periodS = periods.length >= 3 ? median(periods) : null;

  let heaveM = null;
  if (periodS && rms > 0.05) {
    const omega = (2 * Math.PI) / periodS;
    // Amplitude d'un sinus d'accélération RMS : a_rms·√2 / ω².
    const amplitude = (rms * Math.SQRT2) / (omega * omega);
    heaveM = Math.min(8, amplitude * 2); // crête à creux
    peakToPeak.push(heaveM);
    if (peakToPeak.length > 12) peakToPeak.shift();
  }

  const hsEstimate = peakToPeak.length >= 3 ? 1.4 * median(peakToPeak) : heaveM;
  const seaState = beaufortSea(hsEstimate);

  set({
    motion: {
      heaveM,
      hsEstimateM: hsEstimate,
      periodS,
      rms,
      seaState,
      /** Confort : au-delà de 0,35 g RMS, on ne pêche plus, on se tient. */
      rough: rms > 0.35,
      t: Date.now(),
    },
  });

  if (rms > 0.9) emit('alarm', { kind: 'rough-sea', rms });
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Échelle Douglas d'état de la mer, depuis la hauteur significative. */
export function beaufortSea(hs) {
  if (!Number.isFinite(hs)) return null;
  const scale = [
    [0.0, 'Calme (plate)'], [0.1, 'Calme (ridée)'], [0.5, 'Belle (vaguelettes)'],
    [1.25, 'Peu agitée'], [2.5, 'Agitée'], [4, 'Forte'], [6, 'Très forte'], [9, 'Grosse'],
  ];
  let i = 0;
  while (i < scale.length - 1 && hs > scale[i + 1][0]) i++;
  return { degree: i, label: scale[i][1] };
}

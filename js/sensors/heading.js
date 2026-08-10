/* ==========================================================================
 * sensors/heading.js — compas
 * --------------------------------------------------------------------------
 * Le compas d'un téléphone à bord est un capteur difficile. Ce module traite
 * les quatre problèmes réels, dans l'ordre où ils se posent :
 *
 * 1. PERMISSION — iOS 13+ exige DeviceOrientationEvent.requestPermission()
 *    appelé depuis un geste utilisateur. Chrome iOS expose l'API mais PAS
 *    requestPermission : on détecte et on bascule sur la route fond GPS
 *    plutôt que d'afficher un compas mort.
 *
 * 2. RÉFÉRENTIEL — Safari donne webkitCompassHeading, déjà en cap magnétique
 *    horaire. Le standard donne `alpha`, en degrés ANTIhoraires depuis l'est
 *    magnétique ou depuis une origine arbitraire selon `absolute`. Les deux
 *    conventions sont incompatibles : cap = 360 − alpha côté standard.
 *
 * 3. DÉCLINAISON — tout ce qui précède est magnétique. Les caps de carte,
 *    les axes de courant et les relèvements sont VRAIS. On corrige (~0,8° E
 *    en Manche : petit, mais gratuit à corriger).
 *
 * 4. BRUIT ET FER DU BORD — un moteur, un guindeau, un support magnétique de
 *    téléphone déforment le champ. On lisse en circulaire, on mesure la
 *    stabilité, et on compare en permanence à la route fond GPS quand le
 *    bateau avance : un écart constant, c'est une déviation, et on l'affiche
 *    comme telle au lieu de faire semblant.
 * ========================================================================== */

import { set, state, emit } from '../core/store.js';
import { norm360, angleDiff, magToTrue } from '../core/geo.js';

let listening = false;
let handler = null;
const history = [];
const HISTORY = 12;

/* --------------------------------------------------------------------------
 * Lissage
 *
 * Une moyenne glissante sur N mesures retarde l'affichage d'environ (N−1)/2
 * mesures — un retard exprimé en ÉCHANTILLONS, pas en temps. C'est le piège :
 * la cadence de `deviceorientation` n'est garantie nulle part. Sur un iPhone
 * au repos elle approche 60 Hz et huit mesures ne coûtent que 60 ms ; sur un
 * Android qui l'ajuste, ou sur n'importe quel téléphone dont le fil principal
 * est chargé, elle tombe à 8 ou 10 Hz et les mêmes huit mesures deviennent
 * quatre dixièmes de seconde de retard. Le lissage devient d'autant plus
 * pénalisant que l'appareil rame.
 *
 * On raisonne donc en temps, avec un filtre du premier ordre dont la constante
 * s'adapte : lente au repos pour absorber le bruit du magnétomètre, courte dès
 * que l'écart dépasse ce que le bruit peut expliquer — un vrai changement de
 * cap ne doit jamais attendre.
 * ------------------------------------------------------------------------ */
const TAU_STEADY = 180; // ms, cap tenu : on filtre franchement
const TAU_SLEW = 40;    // ms, en giration : on suit
const SLEW_FULL = 10;   // ° d'écart au-delà duquel c'est un virage, pas du bruit
const GAP_RESET = 3000; // ms de silence après quoi on se recale sans transition

let filtered = null;
let lastSampleT = 0;

function smooth(magnetic, now) {
  if (filtered == null || now - lastSampleT > GAP_RESET) {
    filtered = magnetic;
    return magnetic;
  }
  const dt = Math.min(500, Math.max(1, now - lastSampleT));
  const innovation = angleDiff(magnetic, filtered); // signé, plus court chemin
  const w = Math.min(1, Math.abs(innovation) / SLEW_FULL);
  const tau = TAU_STEADY + (TAU_SLEW - TAU_STEADY) * w;
  filtered = norm360(filtered + innovation * (1 - Math.exp(-dt / tau)));
  return filtered;
}

/** Le mode compas est-il seulement possible sur cet appareil ? */
export const supported = () => typeof DeviceOrientationEvent !== 'undefined';

/** iOS Safari : requestPermission existe. Chrome iOS : non. */
export const needsPermission = () =>
  typeof DeviceOrientationEvent !== 'undefined' &&
  typeof DeviceOrientationEvent.requestPermission === 'function';

/**
 * À appeler depuis un vrai geste utilisateur (clic), sinon iOS refuse.
 * @returns {Promise<'granted'|'denied'|'unsupported'|'implicit'>}
 */
export async function requestPermission() {
  if (!supported()) return 'unsupported';
  if (!needsPermission()) {
    start();
    return 'implicit';
  }
  try {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res === 'granted') start();
    return res;
  } catch {
    return 'denied';
  }
}

export function start() {
  if (listening || !supported()) return;
  listening = true;
  handler = onOrientation;
  // `deviceorientationabsolute` est le seul à garantir une référence Nord sur
  // Android. On écoute les deux : le premier qui parle gagne.
  window.addEventListener('deviceorientationabsolute', handler, true);
  window.addEventListener('deviceorientation', handler, true);
}

export function stop() {
  if (!listening) return;
  window.removeEventListener('deviceorientationabsolute', handler, true);
  window.removeEventListener('deviceorientation', handler, true);
  listening = false;
}

let lastEventAt = 0;
let deviation = null; // écart moyen compas − route fond

function onOrientation(e) {
  let magnetic = null;
  let accuracy = null;

  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    magnetic = e.webkitCompassHeading; // iOS : déjà un cap magnétique
    accuracy = e.webkitCompassAccuracy;
  } else if (typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
    if (e.absolute === false) return; // référence arbitraire : inutilisable
    magnetic = norm360(360 - e.alpha);
  }
  if (magnetic == null) return;

  // Compensation d'inclinaison : sur un téléphone tenu à plat, alpha suffit ;
  // couché à plus de 60° du plan horizontal, la mesure part. On préfère
  // signaler l'appareil « mal tenu » plutôt que d'afficher un cap faux.
  const tilted = Math.abs(e.beta ?? 0) > 60 || Math.abs(e.gamma ?? 0) > 60;

  const now = Date.now();
  const value = smooth(magnetic, now);
  lastSampleT = now;

  // Stabilité : dispersion des mesures BRUTES autour du cap filtré. C'est
  // l'agitation du capteur qu'on veut mesurer, pas celle du filtre.
  history.push(magnetic);
  if (history.length > HISTORY) history.shift();
  const spread =
    history.reduce((acc, h) => acc + Math.abs(angleDiff(h, value)), 0) / history.length;

  lastEventAt = now;
  const trueHeading = magToTrue(value);

  set({
    heading: {
      deg: trueHeading,
      magnetic: value,
      source: 'compass',
      spread,
      tilted,
      accuracy,
      quality: tilted ? 'bad' : spread > 12 ? 'poor' : spread > 5 ? 'fair' : 'good',
      deviation,
      t: lastEventAt,
    },
  });
}

/**
 * Repli et contrôle croisé.
 *
 * Si le compas se tait depuis 3 s, on affiche la route fond — mieux vaut une
 * route qu'un cadran figé. Si le compas parle ET que le bateau avance, on
 * compare : un écart stable sur plusieurs mesures est une déviation
 * magnétique du bord, on l'affiche au navigateur au lieu de la subir.
 */
const devSamples = [];

export function tick() {
  const fix = state.fix;
  const h = state.heading;
  const compassAlive = Date.now() - lastEventAt < 3000;

  if (compassAlive && fix?.moving && Number.isFinite(fix.cogDeg) && fix.speedKn > 2) {
    devSamples.push(angleDiff(h.deg, fix.cogDeg));
    if (devSamples.length > 30) devSamples.shift();
    if (devSamples.length >= 10) {
      const mean = devSamples.reduce((a, b) => a + b, 0) / devSamples.length;
      const spread =
        devSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / devSamples.length;
      // Écart cohérent (faible variance) et significatif : c'est une déviation.
      deviation = Math.sqrt(spread) < 12 && Math.abs(mean) > 6 ? Math.round(mean) : null;
    }
  }

  if (!compassAlive) {
    if (fix?.moving && Number.isFinite(fix.cogDeg)) {
      set({
        heading: {
          deg: fix.cogDeg,
          source: 'cog',
          quality: fix.speedKn > 2 ? 'good' : 'fair',
          spread: 0,
          t: Date.now(),
        },
      });
    } else if (state.heading?.source === 'compass') {
      set({ heading: { ...state.heading, source: 'stale', quality: 'stale' } });
    }
  }
}

/**
 * Étalonnage en huit : on demande à l'utilisateur de faire tourner le
 * téléphone. On mesure la couverture angulaire — un magnétomètre saturé ne
 * couvre jamais 360°. Retourne la progression 0..1.
 */
let calibBins = null;

export function startCalibration() {
  calibBins = new Array(36).fill(false);
}

export function calibrationProgress() {
  if (!calibBins || !state.heading) return 0;
  calibBins[Math.floor(norm360(state.heading.magnetic ?? state.heading.deg) / 10)] = true;
  const done = calibBins.filter(Boolean).length / 36;
  if (done >= 0.95) {
    calibBins = null;
    emit('compass:calibrated');
    return 1;
  }
  return done;
}

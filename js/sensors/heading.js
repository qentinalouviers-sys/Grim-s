/* ==========================================================================
 * sensors/heading.js — compas
 * --------------------------------------------------------------------------
 * Le compas d'un téléphone à bord est un capteur difficile. Ce module traite
 * les quatre problèmes réels, dans l'ordre où ils se posent :
 *
 * 1. PERMISSION — iOS 13+ exige DeviceOrientationEvent.requestPermission()
 *    appelé depuis un geste utilisateur, ET À CHAQUE OUVERTURE : le navigateur
 *    mémorise la réponse, pas l'abonnement. S'abonner sans avoir appelé ne
 *    produit aucun événement et aucune erreur — un compas muet, silencieux
 *    jusque dans sa panne. D'où le rattrapage sur premier toucher plus bas.
 *    Chrome iOS expose l'API mais PAS requestPermission : on détecte et on
 *    bascule sur la route fond GPS plutôt que d'afficher un compas mort.
 *
 * 2. RÉFÉRENTIEL — Safari donne webkitCompassHeading, déjà en cap magnétique
 *    horaire. Le standard donne `alpha`, en degrés ANTIhoraires depuis l'est
 *    magnétique ou depuis une origine arbitraire selon `absolute`. Les deux
 *    conventions sont incompatibles : cap = 360 − alpha côté standard. Et les
 *    deux événements arrivent souvent ensemble, en se contredisant : on n'en
 *    retient qu'un, le mieux référencé.
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
  if (!supported()) {
    diag.permission = 'aucun compas';
    return 'unsupported';
  }
  if (!needsPermission()) {
    start();
    diag.permission = 'implicite (sans dialogue)';
    return 'implicit';
  }
  try {
    const res = await DeviceOrientationEvent.requestPermission();
    diag.permission = res === 'granted' ? 'accordée' : `refusée (${res})`;
    if (res === 'granted') start();
    return res;
  } catch (err) {
    // Rejet typique d'iOS : appel hors d'un geste utilisateur. Ce n'est PAS un
    // refus — il faut simplement redemander depuis un vrai toucher.
    diag.permission = 'à redemander (hors geste)';
    return 'gesture-required';
  }
}

/** Le compas a-t-il livré ne serait-ce qu'une mesure ? */
export const alive = () => diag.events > 0 && Date.now() - lastEventAt < 3000;
export const everSpoke = () => diag.events > 0;

/**
 * Rattrapage d'autorisation iOS.
 *
 * Sur iPhone, écouter `deviceorientation` sans avoir appelé requestPermission()
 * ne produit RIEN : pas d'erreur, pas d'événement, un compas simplement muet.
 * Or l'appel n'est accepté que depuis un geste utilisateur — et au deuxième
 * lancement de l'app, il n'y a plus de portail d'accueil pour en fournir un.
 * Le compas restait donc mort à chaque ouverture suivante, et le cap retombait
 * sur la route fond GPS : une valeur qui ne bouge qu'en mouvement et se met à
 * jour une fois par seconde. Vu du pont, ça s'appelle « le compas rame ».
 *
 * On arme donc une demande sur le premier toucher venu. Elle se désarme d'elle
 * même dès que les mesures arrivent, et ne coûte rien si tout allait bien.
 */
export function armGestureRetry(onResult) {
  if (!needsPermission() || everSpoke()) return () => {};

  const retry = async () => {
    const res = await requestPermission();
    if (res === 'granted' || everSpoke()) disarm();
    onResult?.(res);
  };
  const disarm = () => {
    for (const t of ['pointerdown', 'touchend', 'click']) {
      window.removeEventListener(t, retry, true);
    }
  };
  for (const t of ['pointerdown', 'touchend', 'click']) {
    window.addEventListener(t, retry, true);
  }
  return disarm;
}

/** Instantané pour l'écran de diagnostic. Aucune donnée n'est inventée. */
export function diagnostics() {
  const now = Date.now();
  return {
    ...diag,
    listening,
    lockedType: lockedType || '—',
    lockedRank,
    filtered,
    ageMs: lastEventAt ? now - lastEventAt : null,
    uptimeMs: diag.firstAt ? now - diag.firstAt : 0,
    needsPermission: needsPermission(),
    supported: supported(),
  };
}

export function start() {
  if (listening || !supported()) return;
  listening = true;
  handler = onOrientation;
  // On écoute les deux événements parce qu'aucun n'est disponible partout,
  // mais on n'en RETIENT qu'un — voir le verrouillage de source plus bas.
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

/* --------------------------------------------------------------------------
 * Verrouillage de source
 *
 * Les deux événements arrivent souvent EN MÊME TEMPS, et ils ne disent pas la
 * même chose. `deviceorientationabsolute` porte une référence Nord ;
 * `deviceorientation` porte, selon le navigateur, un cap magnétique (iOS, via
 * webkitCompassHeading), un cap absolu, ou un azimut relatif à l'orientation
 * qu'avait le téléphone au chargement de la page — c'est-à-dire n'importe quoi.
 *
 * Les brancher tous les deux sur le même filtre, c'est lui donner deux
 * référentiels différents à concilier : il passe son temps à corriger l'un vers
 * l'autre et le cap affiché rampe en permanence vers une cible qui recule. Un
 * lissage, aussi bien réglé soit-il, ne peut rien contre une entrée
 * contradictoire.
 *
 * On classe donc les sources et on ne garde que la meilleure rencontrée. Le
 * classement peut monter (on découvre mieux) mais jamais redescendre.
 * ------------------------------------------------------------------------ */
const RANK_ARBITRARY = 0; // alpha sans référence : inutilisable
const RANK_ABSOLUTE_ALPHA = 1; // alpha annoncé absolu
const RANK_TRUE_COMPASS = 2; // cap magnétique livré par la plateforme

let lockedRank = -1;
let lockedType = null;

/* Compteurs de diagnostic : sans eux, un compas muet et un compas lent se
 * ressemblent, et on corrige à l'aveugle. */
const diag = {
  events: 0,
  ignored: 0,
  byType: Object.create(null),
  firstAt: 0,
  rateHz: 0,
  field: null,
  absolute: null,
  raw: null,
  accuracy: null,
  beta: null,
  gamma: null,
  permission: 'inconnue',
};
const rateWindow = [];

function classify(e) {
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    return { rank: RANK_TRUE_COMPASS, magnetic: e.webkitCompassHeading, field: 'webkitCompassHeading' };
  }
  if (typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
    // `absolute` vaut true, false, ou rien du tout. L'absence d'information
    // n'est pas une garantie : on ne fait confiance qu'à un true explicite,
    // ou au nom de l'événement, qui lui ne ment pas.
    const trusted = e.absolute === true || e.type === 'deviceorientationabsolute';
    return {
      rank: trusted ? RANK_ABSOLUTE_ALPHA : RANK_ARBITRARY,
      magnetic: norm360(360 - e.alpha),
      field: 'alpha',
    };
  }
  return null;
}

function onOrientation(e) {
  const c = classify(e);
  if (!c || c.rank === RANK_ARBITRARY) {
    diag.ignored++;
    return;
  }
  if (c.rank < lockedRank) {
    diag.ignored++; // une source moins fiable que celle déjà verrouillée
    return;
  }
  if (c.rank > lockedRank || lockedType == null) {
    lockedRank = c.rank;
    lockedType = e.type;
    filtered = null; // on change de référentiel : on repart du neuf
  } else if (e.type !== lockedType) {
    diag.ignored++; // même rang, autre flux : un seul suffit
    return;
  }

  const magnetic = c.magnetic;
  const accuracy = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;

  // Compensation d'inclinaison : sur un téléphone tenu à plat, alpha suffit ;
  // couché à plus de 60° du plan horizontal, la mesure part. On préfère
  // signaler l'appareil « mal tenu » plutôt que d'afficher un cap faux.
  const tilted = Math.abs(e.beta ?? 0) > 60 || Math.abs(e.gamma ?? 0) > 60;

  const now = Date.now();

  diag.events++;
  diag.byType[e.type] = (diag.byType[e.type] || 0) + 1;
  if (!diag.firstAt) diag.firstAt = now;
  rateWindow.push(now);
  while (rateWindow.length && now - rateWindow[0] > 2000) rateWindow.shift();
  diag.rateHz = rateWindow.length > 1
    ? (rateWindow.length - 1) / ((now - rateWindow[0]) / 1000)
    : 0;
  diag.field = c.field;
  diag.absolute = e.absolute ?? null;
  diag.raw = magnetic;
  diag.accuracy = accuracy;
  diag.beta = e.beta ?? null;
  diag.gamma = e.gamma ?? null;

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

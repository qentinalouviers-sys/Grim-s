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
 * Compensation d'inclinaison
 *
 * `alpha` n'est un cap que si le téléphone est POSÉ À PLAT. Dès qu'on le
 * redresse — c'est-à-dire dès qu'on le tient pour le lire — la décomposition
 * d'Euler du W3C (Z-X'-Y'') se dégrade, et à la verticale elle se bloque :
 * alpha et gamma décrivent alors la même rotation. Le cap réel dépend de leur
 * SOMME, pas d'alpha seul. Conséquence mesurée : téléphone redressé et roulé
 * de 20° au poignet, « 360 − alpha » se trompe de 20°, et le moindre
 * mouvement de main fait sauter la valeur d'un bloc.
 *
 * Un compas de bord ne peut pas exiger qu'on pose le téléphone à plat sur le
 * banc pour lire un cap. On repasse donc par la matrice de rotation complète,
 * et on lit la direction sur l'axe le mieux placé :
 *
 *   téléphone à plat      l'axe utile est le HAUT de l'appareil
 *   téléphone redressé    l'axe utile est le DOS — la direction du regard
 *
 * Les deux coïncident quand le téléphone n'est pas roulé ; entre les deux on
 * fond progressivement, pondéré par cos²β, sans discontinuité. Aucun des deux
 * axes n'est jamais dégénéré en même temps que l'autre : leur somme des carrés
 * de projection horizontale vaut au minimum 1.
 * ------------------------------------------------------------------------ */
const DEG = Math.PI / 180;

/**
 * Cap tenu par l'appareil, compensé de l'inclinaison, exprimé dans le
 * référentiel angulaire d'`alpha` (absolu si alpha l'est, relatif sinon).
 *
 * @returns {{deg:number, quality:number}|null} quality ∈ [0,1] : accord entre
 *   les deux axes. Bas = pose ambiguë, la valeur reste utilisable mais floue.
 */
export function headingFromEuler(alpha, beta, gamma) {
  if (![alpha, beta, gamma].every(Number.isFinite)) return null;
  const a = alpha * DEG;
  const b = beta * DEG;
  const g = gamma * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);

  // Colonnes de R = Rz(α)·Rx(β)·Ry(γ), repère terrestre X=Est, Y=Nord, Z=Haut.
  const topX = -sa * cb; // axe +Y appareil : le haut de l'écran
  const topY = ca * cb;
  const backX = -(ca * sg + sa * sb * cg); // axe −Z appareil : le dos
  const backY = -(sa * sg - ca * sb * cg);

  const nTop = Math.hypot(topX, topY); // vaut exactement |cos β|
  const nBack = Math.hypot(backX, backY);

  // Bascule d'axe : c'est l'ÉCRAN qui décide, pas l'inclinaison.
  //
  // Pondérer par l'assiette du téléphone (cos²β) semble naturel et se trompe
  // deux fois. Trop tôt, on injecte l'axe du dos dans une pose à plat qui était
  // exacte — 13° d'erreur gagnés sur le tableau de bord, la pose de référence.
  // Et le critère lui-même est faux : une torsion du poignet fait chuter β sans
  // que le téléphone cesse d'être tenu debout devant les yeux.
  //
  // La bonne question n'est pas « à quel point est-il penché » mais « l'écran
  // regarde-t-il le ciel ou l'utilisateur ». C'est la composante verticale de
  // l'axe perpendiculaire à l'écran, soit cos β · cos γ : elle vaut 1 quand
  // l'appareil est posé à plat, 0 quand il est tenu droit — quelle que soit la
  // torsion. Fondu lissé entre les deux, dérivée nulle aux bornes : pas de saut
  // d'aiguille au passage.
  const screenUp = Math.abs(cb * cg);
  const t = Math.max(0, Math.min(1, (screenUp - 0.26) / (0.55 - 0.26)));
  const w = t * t * (3 - 2 * t);

  const x = (nTop > 1e-6 ? (w * topX) / nTop : 0) + (nBack > 1e-6 ? ((1 - w) * backX) / nBack : 0);
  const y = (nTop > 1e-6 ? (w * topY) / nTop : 0) + (nBack > 1e-6 ? ((1 - w) * backY) / nBack : 0);

  const norm = Math.hypot(x, y);
  if (norm < 1e-6) return null;
  // Cap horaire depuis le Nord : atan2(Est, Nord).
  return { deg: norm360(Math.atan2(x, y) / DEG), quality: norm };
}

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
  alpha: null,
  tiltFix: 0,
  axisQuality: 1,
  permission: 'inconnue',
};
const rateWindow = [];

function classify(e) {
  const tilt = headingFromEuler(e.alpha, e.beta, e.gamma);

  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    // iOS livre un cap magnétique déjà calibré, mais rapporté au haut de
    // l'appareil : il souffre du même blocage de cardan dès qu'on redresse le
    // téléphone. On lui applique la correction d'assiette — la DIFFÉRENCE
    // entre l'axe mixte et l'axe du haut, mesurée dans le référentiel d'alpha.
    // Comme c'est une différence, l'origine arbitraire d'alpha sur iOS
    // s'annule, et à plat la correction est nulle : rien ne change pour qui
    // pose son téléphone sur le banc.
    const fix = tilt ? angleDiff(tilt.deg, norm360(-e.alpha)) : 0;
    return {
      rank: RANK_TRUE_COMPASS,
      magnetic: norm360(e.webkitCompassHeading + fix),
      field: fix ? 'webkitCompassHeading + assiette' : 'webkitCompassHeading',
      tiltFix: fix,
      quality: tilt?.quality ?? 1,
    };
  }
  if (typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
    // `absolute` vaut true, false, ou rien du tout. L'absence d'information
    // n'est pas une garantie : on ne fait confiance qu'à un true explicite,
    // ou au nom de l'événement, qui lui ne ment pas.
    const trusted = e.absolute === true || e.type === 'deviceorientationabsolute';
    return {
      rank: trusted ? RANK_ABSOLUTE_ALPHA : RANK_ARBITRARY,
      magnetic: tilt ? tilt.deg : norm360(360 - e.alpha),
      field: tilt ? 'alpha + assiette' : 'alpha',
      tiltFix: tilt ? angleDiff(tilt.deg, norm360(-e.alpha)) : 0,
      quality: tilt?.quality ?? 1,
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

  // L'inclinaison étant désormais corrigée, la tenir en main n'est plus une
  // faute : on ne signale que les poses où les deux axes de référence se
  // contredisent vraiment — écran retourné, appareil sur la tranche à la
  // verticale. Réclamer un téléphone posé à plat pour lire un cap était une
  // exigence qu'aucun compas de bord ne peut poser.
  const tilted = c.quality < 0.6;

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
  diag.alpha = e.alpha ?? null;
  diag.tiltFix = c.tiltFix ?? 0;
  diag.axisQuality = c.quality ?? 1;

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

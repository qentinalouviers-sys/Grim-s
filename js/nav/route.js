/* ==========================================================================
 * nav/route.js — moteur de navigation vers un point
 * --------------------------------------------------------------------------
 * Un GPS de voiture donne une direction. Un GPS marin doit donner un CAP À
 * TENIR — ce n'est pas la même chose, et c'est toute la différence entre
 * arriver sur le point et arriver un demi-mille sous le vent.
 *
 * Le bateau avance dans une eau qui bouge. Si on se contente de mettre
 * l'étrave sur le relèvement du but, le courant pousse en travers pendant
 * toute la traversée : la route fond décrit une banane, on parcourt plus de
 * distance, et on finit par remonter le courant au dernier mille — le moment
 * où on a le moins envie de le faire.
 *
 * On résout donc le triangle des vitesses à chaque fix :
 *
 *        vitesse surface (ce que fait l'hélice)
 *      + dérive totale   (courant de marée + fardage + résiduel)
 *      = route fond      (ce qu'on veut : le relèvement du but)
 *
 * L'inconnue est l'angle de correction α tel que la composante travers de la
 * dérive soit exactement annulée :
 *
 *        sin(α) = − dérive·sin(θ) / vitesse_surface        θ = dérive − route
 *        CAP À TENIR = route + α
 *        vitesse fond prévue = V·cos(α) + dérive·cos(θ)
 *
 * Deux conséquences que personne n'affiche et qui comptent :
 *   • si |dérive·sin θ| > V, la route est INTENABLE — le courant est plus fort
 *     que ce que le bateau peut compenser. On le dit au lieu d'afficher un cap
 *     impossible ;
 *   • la vitesse fond prévue permet une ETA AVANT même d'avoir commencé à
 *     bouger, là où une ETA basée sur la vitesse mesurée affiche « — » tant
 *     qu'on n'a pas quitté le corps-mort.
 *
 * ── ARRIVÉE ───────────────────────────────────────────────────────────────
 * Un rayon d'arrivée seul ne suffit pas : avec une mer formée et un point pris
 * un peu large, on peut passer à 12 m du but sans jamais entrer dans le cercle
 * de 10 m, et l'app annoncerait l'arrivée trois minutes plus tard, en
 * s'éloignant. On surveille donc aussi le PASSAGE : dès que la distance a
 * cessé de décroître alors qu'on était dans le voisinage, on est arrivé.
 * ========================================================================== */

import { state, set, emit, subscribe } from '../core/store.js';
import { distance, bearing, crossTrack, angleDiff, toRad, courseToSteer, trueToMag } from '../core/geo.js';
import * as stream from '../data/stream.js';
import * as weather from '../data/weather.js';
import * as tide from '../data/tide.js';
import { sunTimes } from '../data/astro.js';

const MS_PER_KN = 0.5144444;

/** Rayon d'arrivée par défaut, en mètres. Sous 10 m on est dans le bruit du GPS. */
export const DEFAULT_ARRIVAL_M = 10;
/** Distance à laquelle on bascule en approche : on ralentit, on regarde dehors. */
export const APPROACH_M = 200;
/** Écart latéral au-delà duquel on prévient. */
export const XTE_ALARM_M = 60;
/** Vitesse retenue pour l'estimation tant que le bateau n'a pas bougé. */
export const DEFAULT_CRUISE_KN = 5;

/* --------------------------------------------------------------------------
 * Cycle de vie
 * ------------------------------------------------------------------------ */

/**
 * Arme la navigation.
 * @param {{lat:number, lon:number, name?:string, note?:string, kind?:string,
 *          id?:string}} dest
 * @param {{arrivalRadiusM?:number, cruiseKn?:number}} [opts]
 */
export function start(dest, opts = {}) {
  if (!Number.isFinite(dest?.lat) || !Number.isFinite(dest?.lon)) return null;
  const fix = state.fix;
  const nav = {
    lat: dest.lat,
    lon: dest.lon,
    name: dest.name || 'Point',
    note: dest.note || '',
    kind: dest.kind || 'point',
    id: dest.id || null,
    startedAt: Date.now(),
    // L'origine sert d'ancre à l'écart latéral. Sans position au départ, la
    // route de référence n'existe pas encore : elle se posera au premier fix.
    origin: fix ? { lat: fix.lat, lon: fix.lon, t: fix.t } : null,
    originDistanceM: fix ? distance(fix, dest) : null,
    arrivalRadiusM: Math.max(5, Math.min(500, opts.arrivalRadiusM ?? DEFAULT_ARRIVAL_M)),
    cruiseKn: opts.cruiseKn ?? state.settings?.cruiseKn ?? DEFAULT_CRUISE_KN,
    phase: 'route',
    bestDistM: fix ? distance(fix, dest) : Infinity,
  };
  set({ nav });
  // Le waypoint reste posé : le compas du mode NAV et la carte le portent déjà,
  // et on ne veut pas deux notions de « but » qui puissent diverger.
  set({ waypoint: { lat: dest.lat, lon: dest.lon, name: nav.name } });
  emit('nav:start', nav);
  return nav;
}

export function stop({ keepWaypoint = false } = {}) {
  if (!state.nav) return;
  const done = state.nav;
  set({ nav: null });
  if (!keepWaypoint) set({ waypoint: null });
  offCourseSince = 0;
  emit('nav:stop', done);
}

export const active = () => !!state.nav;

/** Change le rayon d'arrivée en cours de route (feuille de réglage). */
export function setArrivalRadius(m) {
  if (!state.nav) return;
  const nav = { ...state.nav, arrivalRadiusM: Math.max(5, Math.min(500, Math.round(m))) };
  set({ nav });
}

/** Repose l'origine de la route sur la position actuelle (« recaler ici »). */
export function resetLeg() {
  const fix = state.fix;
  if (!state.nav || !fix) return;
  set({
    nav: {
      ...state.nav,
      origin: { lat: fix.lat, lon: fix.lon, t: fix.t },
      originDistanceM: distance(fix, state.nav),
      bestDistM: distance(fix, state.nav),
      phase: 'route',
    },
  });
}

/* --------------------------------------------------------------------------
 * Solution de navigation
 * ------------------------------------------------------------------------ */

/**
 * Tout ce qu'il faut pour tenir la barre, calculé en une passe (~0,2 ms).
 * @returns {null | {
 *   ok:boolean, dest:{lat,lon,name}, distanceM:number, bearingDeg:number,
 *   ctsDeg:number, ctsMagDeg:number, driftAngleDeg:number, holdable:boolean,
 *   xteM:number, sogKn:number, vmgKn:number, sogPredictedKn:number,
 *   stwKn:number, ttgMs:number|null, etaT:number|null, drift:object,
 *   turnDeg:number|null, phase:string, atArrival:object|null }}
 */
export function solve(now = Date.now()) {
  const nav = state.nav;
  if (!nav) return null;

  const dest = { lat: nav.lat, lon: nav.lon, name: nav.name };
  const fix = state.fix;
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const pos = fix ? { lat: fix.lat, lon: fix.lon } : null;

  // Dérive totale sur la position courante — à défaut, sur le but : mieux vaut
  // le courant du secteur visé que pas de courant du tout.
  const drift = stream.driftVector(now, pos || dest, wx);

  if (!fix) {
    return {
      ok: false, dest, drift, phase: nav.phase,
      distanceM: null, bearingDeg: null, ctsDeg: null, ctsMagDeg: null,
      driftAngleDeg: 0, holdable: true, xteM: null, sogKn: null, vmgKn: null,
      sogPredictedKn: null, stwKn: null, ttgMs: null, etaT: null, turnDeg: null,
      atArrival: null,
    };
  }

  const distanceM = distance(fix, dest);
  const bearingDeg = bearing(fix, dest);

  /* --- Vitesse surface -------------------------------------------------- *
   * Ce que fait l'hélice, et non ce que fait le bateau : c'est cette
   * grandeur-là qui borne la correction de dérive. On la déduit du fix par
   * différence vectorielle route-fond − dérive, ce qui reste la seule mesure
   * disponible sans speedomètre à bord. Sans mouvement, on retombe sur la
   * vitesse de croisière déclarée : une estimation annoncée vaut mieux qu'un
   * tiret. */
  const sogKn = Number.isFinite(fix.speedKn) ? fix.speedKn : 0;
  let stwKn = nav.cruiseKn;
  if (fix.moving && Number.isFinite(fix.cogDeg)) {
    const sogE = sogKn * Math.sin(toRad(fix.cogDeg)) - drift.spd * Math.sin(toRad(drift.dir));
    const sogN = sogKn * Math.cos(toRad(fix.cogDeg)) - drift.spd * Math.cos(toRad(drift.dir));
    const measured = Math.hypot(sogE, sogN);
    // Un mètre de houle fait osciller la vitesse fond : on lisse, sinon le cap
    // à tenir danse de trois degrés à chaque vague.
    stwKn = stwFilter == null ? measured : stwFilter + 0.25 * (measured - stwFilter);
    stwFilter = stwKn;
  }
  stwKn = Math.max(0.4, stwKn);

  /* --- Triangle des vitesses -------------------------------------------- */
  const tri = courseToSteer({
    bearingDeg,
    driftDirDeg: drift.dir,
    driftKn: drift.spd,
    stwKn,
  });
  const { ctsDeg, driftAngleDeg, holdable } = tri;
  const sogPredictedKn = Math.max(0, tri.sogKn);

  /* --- Écart latéral ----------------------------------------------------- */
  const xteM = nav.origin ? crossTrack(fix, nav.origin, dest) : 0;

  /* --- Vitesse de rapprochement ------------------------------------------ *
   * La VMG mesurée est la vérité du terrain — elle intègre la houle, le
   * ralentissement dans le clapot, la main du barreur. On lui fait confiance
   * dès qu'elle est franche, et on retombe sur la prévision sinon. */
  const vmgKn = fix.moving && Number.isFinite(fix.cogDeg)
    ? sogKn * Math.cos(toRad(angleDiff(fix.cogDeg, bearingDeg)))
    : 0;
  const speedForEta = vmgKn > 0.4 ? vmgKn : sogPredictedKn > 0.4 ? sogPredictedKn : null;
  const ttgMs = speedForEta ? (distanceM / (speedForEta * MS_PER_KN)) * 1000 : null;
  const etaT = ttgMs != null ? now + ttgMs : null;

  const heading = state.heading?.deg ?? fix.cogDeg ?? null;
  const turnDeg = Number.isFinite(heading) ? angleDiff(ctsDeg, heading) : null;

  return {
    ok: true,
    dest,
    distanceM,
    bearingDeg,
    ctsDeg,
    ctsMagDeg: trueToMag(ctsDeg),
    driftAngleDeg,
    holdable,
    xteM,
    sogKn,
    vmgKn,
    sogPredictedKn,
    stwKn,
    ttgMs,
    etaT,
    drift,
    turnDeg,
    phase: nav.phase,
    atArrival: etaT ? environmentAt(etaT, dest) : null,
  };
}

let stwFilter = null;

/**
 * Ce qu'on trouvera SUR LE POINT à l'heure d'arrivée. Un GPS qui annonce
 * « arrivée 18 h 40 » sans dire qu'il y aura 1,9 nœud de jusant et 40 cm d'eau
 * de moins qu'au départ ne fait que la moitié du travail.
 */
function environmentAt(t, dest) {
  const st = stream.tidalStream(t, dest);
  const sun = sunTimes(new Date(t), dest.lat, dest.lon);
  return {
    t,
    tideM: tide.height(t),
    tideDeltaM: tide.height(t) - tide.height(Date.now()),
    stream: { spd: st.spd, dir: st.dir, sense: st.sense },
    slackT: st.slackT,
    afterSunset: t > sun.sunsetT || t < sun.sunriseT,
    sunsetT: sun.sunsetT,
  };
}

/* --------------------------------------------------------------------------
 * Machine d'arrivée
 * --------------------------------------------------------------------------
 * Trois phases, trois messages, trois gestes différents à bord :
 *   route     on tient le cap, on regarde l'écran de temps en temps
 *   approche  200 m : on lève le nez, on réduit, on prépare la manœuvre
 *   arrivée   on est dessus — l'écran doit le crier une fois, puis se taire
 * ------------------------------------------------------------------------ */
let offCourseSince = 0;

subscribe('fix', () => {
  const nav = state.nav;
  const fix = state.fix;
  if (!nav || !fix) return;

  // Origine différée : la navigation a pu être armée sans position.
  if (!nav.origin) {
    set({
      nav: {
        ...nav,
        origin: { lat: fix.lat, lon: fix.lon, t: fix.t },
        originDistanceM: distance(fix, nav),
      },
    });
    return;
  }

  const d = distance(fix, nav);
  const radius = nav.arrivalRadiusM;
  const best = Math.min(nav.bestDistM ?? Infinity, d);

  if (nav.phase !== 'arrived') {
    /* Passage du travers : on s'éloigne alors qu'on était dans le voisinage
     * immédiat. Le seuil de 5 m évite qu'un fix bruité déclenche l'arrivée à
     * 40 m du but. */
    const passed = best <= Math.max(2 * radius, 25) && d > best + 5;
    const inside = d <= radius + Math.min(10, (fix.accuracy || 0) * 0.5);

    if (inside || passed) {
      set({ nav: { ...nav, phase: 'arrived', bestDistM: best, arrivedAt: Date.now(), arrivedDistM: best } });
      emit('nav:arrived', { name: nav.name, distanceM: best, passed });
      return;
    }
    if (nav.phase !== 'approach' && d <= APPROACH_M) {
      set({ nav: { ...nav, phase: 'approach', bestDistM: best } });
      emit('nav:approach', { name: nav.name, distanceM: d });
      return;
    }
    // Repartir du but rearme la navigation : on a tourné autour, on y revient.
    if (nav.phase === 'approach' && d > APPROACH_M * 1.5) {
      set({ nav: { ...nav, phase: 'route', bestDistM: d } });
      return;
    }
  }

  if (best !== nav.bestDistM) set({ nav: { ...nav, bestDistM: best } });

  /* --- Veille d'écart latéral ------------------------------------------- *
   * Une alerte immédiate au premier mètre d'écart serait insupportable dans le
   * clapot. On attend que l'écart tienne quinze secondes avant de le dire, et
   * on ne le redit pas avant deux minutes. */
  if (nav.phase === 'route') {
    const xte = Math.abs(crossTrack(fix, nav.origin, nav));
    const now = Date.now();
    if (xte > XTE_ALARM_M) {
      if (!offCourseSince) offCourseSince = now;
      else if (now - offCourseSince > 15000) {
        offCourseSince = now + 120000; // silence de deux minutes
        emit('nav:offcourse', { xteM: xte });
      }
    } else if (offCourseSince && offCourseSince <= now) {
      offCourseSince = 0;
    }
  }
});

/* --------------------------------------------------------------------------
 * Libellés
 * ------------------------------------------------------------------------ */

/** « 12° à droite » — l'ordre de barre, pas un écart abstrait. */
export function steerLabel(turnDeg) {
  if (!Number.isFinite(turnDeg)) return '—';
  const a = Math.round(Math.abs(turnDeg));
  if (a <= 2) return 'cap bon';
  return `${a}° à ${turnDeg > 0 ? 'droite' : 'gauche'}`;
}

/** Sens de la correction d'écart latéral : de quel bord revenir sur la route. */
export function xteLabel(xteM) {
  if (!Number.isFinite(xteM)) return '—';
  const a = Math.abs(xteM);
  if (a < 8) return 'sur la route';
  return `${a < 1852 ? `${Math.round(a)} m` : `${(a / 1852).toFixed(2)} NM`} ${xteM > 0 ? 'à droite' : 'à gauche'} de la route`;
}

/* ==========================================================================
 * main.js — orchestrateur
 * --------------------------------------------------------------------------
 * Séquence de démarrage, pensée pour le pire cas : téléphone froid, pas de
 * réseau, batterie basse, quelqu'un qui est déjà en mer.
 *
 *   1. l'app s'affiche AVANT toute requête réseau ;
 *   2. marée, soleil, lune, courant sont calculés à bord — donc un écran
 *      utile existe dès la première frame, sans connexion ;
 *   3. la météo arrive quand elle arrive et enrichit le tableau ;
 *   4. rien ne bloque sur une permission refusée.
 *
 * Deux boucles seulement :
 *   tick rapide  (1 s)  capteurs, horloges, contrôle croisé du compas
 *   tick lent    (5 min) météo, échantillons, scoring, conseil
 * ========================================================================== */

import { state, set, subscribe, on } from './core/store.js';
import { APP_VERSION } from './core/build.js';
import * as idb from './core/idb.js';
import * as dom from './ui/dom.js';
import * as fmt from './core/fmt.js';
import { distance, bearing } from './core/geo.js';

import * as tide from './data/tide.js';
import * as weatherApi from './data/weather.js';
import * as stream from './data/stream.js';
import { sunTimes } from './data/astro.js';

import * as gps from './sensors/gps.js';
import * as compass from './sensors/heading.js';
import * as motion from './sensors/motion.js';

import * as spots from './fishing/spots.js';
import * as engine from './fishing/engine.js';
import * as advisor from './fishing/advisor.js';
import * as learning from './fishing/learning.js';
import * as record from './fishing/record.js';
import { SPECIES_ORDER } from './fishing/species.js';

import * as navView from './views/nav.js';
import * as mapView from './views/map.js';
import * as fishView from './views/fish.js';
import * as logView from './views/log.js';

const HOUR = 3600000;
const VIEWS = { nav: navView, map: mapView, fish: fishView, log: logView };

let current = null;
let slowTimer = 0;
let fastTimer = 0;
let wakeLock = null;

/* ==========================================================================
 * Démarrage
 * ========================================================================== */
async function boot() {
  dom.initSheet();
  wireChrome();
  registerServiceWorker();

  // Persistance : sans ça iOS purge IndexedDB après 7 jours d'inactivité —
  // exactement le scénario « je n'ai pas rouvert l'app depuis la sortie
  // d'avant et je suis au large sans réseau ».
  idb.requestPersistence();

  // Rien de tout ceci ne dépend du réseau : ça ne peut pas échouer longtemps.
  await Promise.all([tide.init(), spots.init(), learning.init(), record.initRecord()]);

  const settings = (await idb.get('kv', 'settings')) || {};
  set({ settings, nightMode: !!settings.nightMode });
  document.body.classList.toggle('night', !!settings.nightMode);

  record.mountFab();
  showView(location.hash.replace('#', '') || 'nav');
  slowTick();
  fastTimer = setInterval(fastTick, 1000);
  slowTimer = setInterval(slowTick, 5 * 60_000);

  // Le portail ne s'affiche qu'une fois, mais les capteurs se redemandent à
  // chaque ouverture : iOS retient la réponse, pas l'abonnement.
  const seen = await idb.get('kv', 'onboarded');
  if (seen) {
    document.getElementById('gate').hidden = true;
    startSensors(false);
  }
}

/* ==========================================================================
 * Capteurs
 * ========================================================================== */
async function startSensors(interactive) {
  dom.primeAudio();

  /* L'ORDRE EST CRITIQUE, et il était inversé.
   *
   * iOS n'accepte DeviceOrientationEvent.requestPermission() que dans la
   * fenêtre ouverte par un geste utilisateur. Or on attendait d'abord une
   * position GPS — jusqu'à douze secondes de délai, davantage sur un départ à
   * froid au fond d'un bassin. Quand la demande d'orientation arrivait enfin,
   * la fenêtre du geste était close depuis longtemps : iOS la rejetait sans un
   * mot, et le compas restait mort tout le reste de la session.
   *
   * Les deux capteurs n'ont d'ailleurs rien à voir l'un avec l'autre. Les
   * enchaîner ne servait à rien et coûtait le compas. */
  const res = await compass.requestPermission();
  if (res === 'denied') {
    dom.banner('Compas refusé. Le cap sera la route fond GPS, valable seulement en mouvement.', 'warn', { id: 'nocompass' });
  } else if (res === 'unsupported') {
    dom.banner('Pas de compas sur cet appareil : le cap affiché est la route fond GPS.', 'info', { id: 'nocompass' });
  }
  await motion.requestPermission();

  // Au deuxième lancement il n'y a plus de portail, donc plus de geste
  // utilisateur pour porter la demande — et iOS la rejette silencieusement.
  // On la remet sur le premier toucher, et on le dit si le compas reste muet.
  watchCompassWakeUp();

  // Position ensuite, et sans bloquer personne. getCurrentPosition avant
  // watchPosition reste nécessaire — sur iOS, attaquer directement par
  // watchPosition laisse parfois trente secondes sans dialogue système — mais
  // cette attente n'a plus à retarder quoi que ce soit.
  gps.prime().then((ok) => {
    gps.start();
    if (!ok && interactive) {
      dom.banner('Position refusée ou indisponible. Marée, courant et pêche restent calculés sur Dieppe.', 'warn', { id: 'nogps' });
    }
  });

  requestWakeLock();
}

/**
 * Filet de sécurité du compas. On laisse une seconde et demie au capteur ; s'il
 * n'a toujours rien dit, on arme une nouvelle demande d'autorisation sur le
 * prochain toucher et on explique pourquoi l'écran affiche une route et pas un
 * cap. Le bandeau disparaît dès la première mesure.
 */
function watchCompassWakeUp() {
  if (!compass.supported() || compass.everSpoke()) return;

  setTimeout(() => {
    if (compass.everSpoke()) return;
    const disarm = compass.armGestureRetry(() => {
      if (compass.everSpoke()) {
        dom.dismissBanner?.('wakecompass');
        dom.toast('Compas actif', 'good');
      }
    });
    if (compass.needsPermission()) {
      dom.banner(
        'Compas en attente : touche l’écran une fois pour l’autoriser. iOS redemande cette permission à chaque ouverture.',
        'warn',
        { id: 'wakecompass' },
      );
    } else {
      // Pas de dialogue à passer sur cette plateforme : si le capteur se tait,
      // ce n'est pas une question d'autorisation. On le dit, et on ne laisse
      // pas d'écouteur de geste tourner pour rien.
      disarm();
      dom.banner(
        'Compas silencieux. Le cap affiché est la route fond GPS — juste seulement en mouvement. Touche le cadran pour voir le diagnostic.',
        'warn',
        { id: 'wakecompass' },
      );
    }
  }, 1500);
}

/**
 * Écran maintenu allumé. Sur un bateau, l'écran qui s'éteint au moment où on
 * regarde le cap est un vrai problème de sécurité — et le réveiller les mains
 * mouillées est pire.
 */
async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
  } catch { /* refusé ou batterie basse : tant pis */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!wakeLock) requestWakeLock();
    slowTick();
  }
});

/* ==========================================================================
 * Boucle rapide
 * ========================================================================== */
function fastTick() {
  compass.tick();

  const fix = state.fix;
  const dot = document.getElementById('gps-dot');
  const txt = document.getElementById('gps-text');
  if (fix) {
    const age = Date.now() - fix.t;
    const good = age < 8000 && (fix.accuracy ?? 99) < 25;
    dot.className = `dot ${good ? 'live' : age < 60000 ? 'weak' : 'dead'}`;
    // À l'arrêt, vitesse et route fond sont du bruit : on n'affiche pas deux
    // tirets là où la précision du fix est l'information utile.
    txt.textContent = fix.moving
      ? `${fmt.num(fix.speedKn, 1)} nd · ${fmt.heading(fix.cogDeg)}`
      : `Fixé · ±${Math.round(fix.accuracy ?? 0)} m`;
  } else {
    dot.className = 'dot dead';
    txt.textContent = 'GPS —';
  }
  renderStatusChips();
}

function renderStatusChips() {
  const host = document.getElementById('status-chips');
  const now = Date.now();
  const info = tide.info(now);
  const next = tide.next(now, 1)[0];
  const st = stream.tidalStream(now, state.fix || spots.getPort());

  const chips = [
    { txt: `${info.label}`, cls: info.trust === 'high' ? 'good' : info.trust === 'low' ? 'warn' : '' },
    next ? { txt: `${next.kind === 'HW' ? 'PM' : 'BM'} ${info.provisional ? '≈' : ''}${fmt.hhmm(next.t)}`, cls: '' } : null,
    { txt: `Coef ${tide.coefficient(now)}`, cls: '' },
    { txt: `${fmt.num(st.spd, 1)} nd ${fmt.cardinal(st.dir)}`, cls: st.sense === 'slack' ? '' : 'good' },
    state.weather?.stale ? { txt: `Météo ${fmt.age(state.weather.fetchedAt)}`, cls: 'warn' } : null,
    !state.online ? { txt: 'Hors ligne', cls: 'warn' } : null,
    state.anchor?.armed ? { txt: '⚓ Veille', cls: 'good' } : null,
    state.trip ? { txt: `⏱ ${fmt.dist(state.trip.distanceM)}`, cls: '' } : null,
  ].filter(Boolean);

  const signature = chips.map((c) => c.txt + c.cls).join('|');
  if (host.dataset.sig === signature) return; // évite de recréer le DOM chaque seconde
  host.dataset.sig = signature;
  dom.clear(host);
  for (const c of chips) host.append(dom.chip(c.txt, c.cls));
}

/* ==========================================================================
 * Boucle lente : données et calcul
 * ========================================================================== */
let slowRunning = false;

async function slowTick(opts = {}) {
  if (slowRunning) return;
  slowRunning = true;
  try {
    const pos = state.fix
      ? { lat: state.fix.lat, lon: state.fix.lon }
      : { lat: spots.getPort().lat, lon: spots.getPort().lon };

    const wx = await weatherApi.load(pos.lat, pos.lon, { force: !!opts.force });
    set({ weather: wx });

    if (wx.stale && wx.hourly.length) {
      dom.banner(`Météo datant de ${fmt.age(wx.fetchedAt)} — scores calculés dessus.`, 'info', { id: 'stalewx' });
    }

    recompute(pos, wx.hourly);
  } catch (e) {
    console.error('[slowTick]', e);
  } finally {
    slowRunning = false;
  }
}

/** Recalcule échantillons, scores et conseil. Purement local, ~40 ms. */
function recompute(pos, hourly) {
  const now = Date.now();
  const from = now - 2 * HOUR;
  const to = now + 3 * 24 * HOUR;

  const samples = engine.buildSamples({ from, to, stepMinutes: 30, pos, hourly });
  const scores = engine.scoreAll(samples, SPECIES_ORDER);
  const sun = sunTimes(new Date(now), pos.lat, pos.lon);
  const advice = advisor.brief({
    now, samples, scores, hourly, pos, tideInfo: tide.info(now), sun,
  });

  set({ samples, scores, advice });

  // Le bandeau « modèle de marée non calé » n'est pas une info secondaire :
  // il conditionne la confiance à accorder à toutes les heures affichées.
  if (tide.info(now).provisional) {
    dom.banner(
      "Modèle de marée non calé : heures de PM/BM à ±30 min. Une seule connexion suffit à l'ajuster sur la donnée SHOM.",
      'warn',
      { id: 'provisional' },
    );
  }
}

on('data:refresh', (o) => slowTick(o || { force: true }));

// Une position significativement différente change le champ de courant et les
// postes accessibles : on recalcule, mais pas à chaque fix (ce serait 1 Hz).
let lastRecomputePos = null;
subscribe('fix', () => {
  const f = state.fix;
  if (!f) return;
  if (!lastRecomputePos) {
    lastRecomputePos = f;
    return;
  }
  const moved = Math.hypot(f.lat - lastRecomputePos.lat, f.lon - lastRecomputePos.lon) * 111000;
  if (moved > 1500) {
    lastRecomputePos = f;
    recompute({ lat: f.lat, lon: f.lon }, state.weather?.hourly || []);
  }
});

/* ==========================================================================
 * Navigation entre les modes
 * ========================================================================== */
function showView(name) {
  if (!VIEWS[name]) name = 'nav';
  if (current === name) {
    VIEWS[name].refresh?.();
    return;
  }
  if (current) {
    VIEWS[current].unmount?.();
    document.getElementById(`view-${current}`).hidden = true;
  }
  current = name;
  const host = document.getElementById(`view-${name}`);
  host.hidden = false;
  VIEWS[name].mount(host);

  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.goto === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  record.setFabVisible(name !== 'log');
  history.replaceState(null, '', `#${name}`);
  set({ view: name });
}

on('goto', showView);

/* ==========================================================================
 * Habillage : onglets, boutons, alarmes
 * ========================================================================== */
function wireChrome() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      navigator.vibrate?.(8);
      showView(tab.dataset.goto);
    });
  }

  document.getElementById('gate-go').addEventListener('click', async () => {
    document.getElementById('gate').hidden = true;
    await idb.put('kv', 'onboarded', true);
    startSensors(true);
  });
  document.getElementById('gate-skip').addEventListener('click', async () => {
    document.getElementById('gate').hidden = true;
    await idb.put('kv', 'onboarded', true);
  });

  document.getElementById('btn-night').addEventListener('click', async () => {
    const on = !state.nightMode;
    set({ nightMode: on });
    document.body.classList.toggle('night', on);
    document.getElementById('btn-night').classList.toggle('on', on);
    await idb.put('kv', 'settings', { ...(state.settings || {}), nightMode: on });
  });

  document.getElementById('btn-mob').addEventListener('click', onMOB);

  document.getElementById('chip-gps').addEventListener('click', () => showFixDetail());
}

/**
 * Homme à la mer. Un seul appui, pas de confirmation : à ce moment-là on n'a
 * pas trois secondes. La position est figée immédiatement, l'alarme part, et
 * le relèvement apparaît sur le compas et la carte.
 */
function onMOB() {
  if (state.mob) {
    dom.openSheet('Homme à la mer', mobPanel());
    return;
  }
  const m = gps.markMOB();
  if (!m) return void dom.toast('Pas de position GPS — impossible de marquer', 'danger');
  navigator.vibrate?.([100, 60, 100, 60, 400]);
  dom.toast('MOB marqué — position figée', 'danger', 5000);
  showView('map');
}

function mobPanel() {
  const body = dom.el('div');
  const m = state.mob;
  body.append(dom.el('p', 'muted', `Marqué à ${fmt.hhmmss(m.t)} · ${fmt.posDDM(m)}`));
  if (state.fix) {
    const d = distance(state.fix, m);
    const b = bearing(state.fix, m);
    body.append(dom.el('p', 'metric-val sm c-red', `${fmt.dist(d)} au ${fmt.heading(b)}`));
    // La dérive de la personne à l'eau n'est PAS celle du bateau : pas de
    // fardage, ou très peu. On la prédit avec le courant seul.
    const pred = stream.predictDrift(m, m.t, Math.max(1, (Date.now() - m.t) / 60000), []);
    const drifted = pred.points.at(-1);
    if (drifted && Date.now() - m.t > 60000) {
      body.append(dom.el('p', 'list-sub',
        `Position dérivée estimée (courant seul) : ${fmt.posDDM(drifted)} — ${fmt.dist(distance(m, drifted))} du point de chute.`));
    }
  }
  body.append(dom.el('p', 'tiny', 'Appel VHF canal 16 · MAYDAY si vie en danger. Garde un équipier en observation permanente sur la personne à l’eau.'));
  body.append(dom.button('Effacer le MOB', 'btn-ghost btn-lg', () => {
    gps.clearMOB();
    dom.closeSheet();
  }));
  return body;
}

function showFixDetail() {
  const f = state.fix;
  const body = dom.el('div');
  if (!f) {
    body.append(dom.el('p', 'muted', "Aucune position. Vérifie l'autorisation de localisation dans les réglages du téléphone."));
    body.append(dom.button('Réessayer', 'btn-primary btn-lg', () => startSensors(true)));
  } else {
    const rows = [
      ['Latitude', fmt.latDDM(f.lat)],
      ['Longitude', fmt.lonDDM(f.lon)],
      ['Précision', `± ${Math.round(f.accuracy || 0)} m`],
      ['Vitesse fond', `${fmt.num(f.speedKn, 1)} nd`],
      ['Route fond', fmt.heading(f.cogDeg)],
      ['Dernier fix', fmt.age(f.t)],
    ];
    for (const [k, v] of rows) {
      const r = dom.el('div', 'row');
      r.style.justifyContent = 'space-between';
      r.style.padding = '4px 0';
      r.append(dom.el('span', 'tiny', k), dom.el('span', 'tnum', v));
      body.append(r);
    }
    body.append(dom.button('📋 Copier la position', 'btn-lg', async () => {
      try {
        await navigator.clipboard.writeText(fmt.posDDM(f));
        dom.toast('Position copiée', 'good');
      } catch {
        dom.toast('Copie impossible');
      }
    }));
  }
  dom.openSheet('Position', body);
}

/* --- Alarmes --------------------------------------------------------- */
on('alarm', (a) => {
  if (a.kind === 'anchor') {
    dom.alarm(
      '⚓ DÉRAPAGE',
      `${Math.round(a.distanceM)} m du point de mouillage (rayon ${a.radiusM} m)`,
      () => gps.weighAnchor(),
    );
  } else if (a.kind === 'mob') {
    navigator.vibrate?.([200, 80, 200, 80, 600]);
  }
});

on('drift:record', () => {
  showView('map');
  dom.toast('Coupe le moteur, laisse dériver, puis « ⏱ Relever »');
});

/* --- Sortie enregistrée ---------------------------------------------- */
on('trip:saved', async (trip) => {
  if (!trip?.points?.length) return;
  await idb.put('tracks', null, { id: `t${trip.startedAt}`, ...trip });
});

/* ==========================================================================
 * Service worker
 * ========================================================================== */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            // La coque est servie depuis le cache : le code déjà chargé reste
            // l'ancien jusqu'au rechargement. Proposer un bouton plutôt qu'une
            // consigne — « relance l'app » est une manœuvre ambiguë sur une PWA
            // installée, et une correction qu'on n'exécute pas n'existe pas.
            const b = dom.banner(
              `Version ${APP_VERSION} téléchargée.`,
              'info',
              { id: 'update' },
            );
            b?.querySelector('span')?.after(
              dom.button('Appliquer', 'btn-sm', () => location.reload()),
            );
          }
        });
      });
    }).catch(() => {});
  });
}

/* ==========================================================================
 * Garde-fous
 * ========================================================================== */
window.addEventListener('error', (e) => console.error('[erreur]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[promesse]', e.reason));

// Empêche le zoom par double-tap : sur un bateau qui bouge, un doigt qui
// rebondit ne doit pas déclencher un zoom sur le tableau de bord.
let lastTouch = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouch < 320) e.preventDefault();
  lastTouch = now;
}, { passive: false });

boot();

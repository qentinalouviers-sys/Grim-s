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

import { state, set, subscribe, on, emit } from './core/store.js';
import { APP_VERSION } from './core/build.js';
import * as idb from './core/idb.js';
import * as presence from './core/presence.js';
import * as profile from './core/profile.js';
import * as dom from './ui/dom.js';
import * as sos from './ui/sos.js';
import * as anchorwatch from './core/anchorwatch.js';
import * as wxalert from './core/wxalert.js';
import * as install from './ui/install.js';
import * as fmt from './core/fmt.js';
import { distance, bearing } from './core/geo.js';

import * as tide from './data/tide.js';
import * as seabed from './data/seabed.js';
import * as bathy from './data/bathy.js';
import * as wrecks from './data/wrecks.js';
import * as weatherApi from './data/weather.js';
import * as places from './data/places.js';
import * as stream from './data/stream.js';
import { sunTimesOfDay } from './data/astro.js';

import * as gps from './sensors/gps.js';
import * as compass from './sensors/heading.js';
import * as motion from './sensors/motion.js';

import * as spots from './fishing/spots.js';
import * as engine from './fishing/engine.js';
import * as advisor from './fishing/advisor.js';
import * as learning from './fishing/learning.js';
import * as record from './fishing/record.js';
import * as traces from './fishing/traces.js';
import * as sync from './core/sync.js';
import { SPECIES_ORDER } from './fishing/species.js';

// Importé pour son effet de bord autant que pour son API : le module abonne la
// machine d'arrivée au flux GPS dès son chargement. Sans cet import, une route
// armée depuis la carte ne détecterait jamais qu'on est arrivé.
import * as route from './nav/route.js';

import * as navView from './views/nav.js';
import * as pilotView from './views/pilot.js';
import * as driveView from './views/drive.js';
import * as fishModeView from './views/fishmode.js';
import * as mapView from './views/map.js';
import * as horizonView from './views/horizon.js';
import * as fishView from './views/fish.js';
import * as logView from './views/log.js';

const HOUR = 3600000;
const VIEWS = {
  nav: navView,
  pilot: pilotView,
  drive: driveView,
  'fish-mode': fishModeView,
  map: mapView,
  horizon: horizonView,
  fish: fishView,
  log: logView,
};

let current = null;
let slowTimer = 0;
let fastTimer = 0;
let wakeLock = null;

/* ==========================================================================
 * Démarrage
 * ========================================================================== */
async function boot() {
  dom.initSheet();
  install.init();
  measureChrome();
  wireChrome();
  registerServiceWorker();

  // Persistance : sans ça iOS purge IndexedDB après 7 jours d'inactivité —
  // exactement le scénario « je n'ai pas rouvert l'app depuis la sortie
  // d'avant et je suis au large sans réseau ».
  idb.requestPersistence();

  // Rien de tout ceci ne dépend du réseau : ça ne peut pas échouer longtemps.
  // La nature des fonds est facultative : si le fichier manque, tout le reste
  // fonctionne à l'identique. On ne bloque donc pas le démarrage dessus.
  seabed.init();
  bathy.init();
  wrecks.init();
  presence.init();
  await Promise.all([
    tide.init(), spots.init(), learning.init(), record.initRecord(), traces.init(),
    // Le port retenu doit être connu AVANT le premier tour lent : c'est lui qui
    // décide de quelle côte on télécharge la météo quand le GPS n'a encore rien
    // dit — c'est-à-dire pendant les dix à trente premières secondes, celles où
    // l'écran se remplit.
    places.init(),
    // La veille de mouillage se restaure avant l'affichage : si l'app a été
    // déchargée par le système pendant qu'on mouillait, elle doit repartir
    // armée, pas rester silencieuse.
    anchorwatch.init(),
    // Les alertes météo doivent être en mémoire avant le premier tour lent :
    // c'est lui qui les évalue contre la prévision qui vient d'arriver.
    wxalert.init(),
  ]);

  const settings = (await idb.get('kv', 'settings')) || {};
  set({ settings, nightMode: !!settings.nightMode });
  await profile.init();
  document.body.classList.toggle('night', !!settings.nightMode);

  // Compte & synchro : restaure la session puis synchronise en tâche de fond,
  // sans jamais bloquer l'écran ni dépendre du réseau.
  await sync.initSync();
  if (sync.isLoggedIn()) setTimeout(() => sync.sync().catch(() => {}), 2000);

  record.mountFab();
  syncNavTab();
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
  install.maybeOffer();
  lockOrientation();
}

/* ==========================================================================
 * Mesure de la coque d'écran
 * --------------------------------------------------------------------------
 * La hauteur de la barre d'état était écrite en dur (78 px). Elle ne l'est
 * jamais : elle vaut le retrait haut de l'appareil (47 px sur un iPhone à
 * encoche, 0 sur un vieux modèle) plus la ligne d'actions plus la ligne de
 * pastilles, qui passe à deux lignes dès qu'il y a beaucoup d'informations.
 * Sur un smartphone récent le total dépasse 115 px.
 *
 * Conséquence, et c'était le défaut signalé : le bandeau d'alerte, calé sur
 * `top: var(--topbar-h)`, se dessinait SOUS la barre d'état. Le message
 * « touche l'écran pour autoriser le compas » était invisible et, pire, son
 * bouton était inatteignable — la barre le recouvrait et captait le toucher.
 * On mesure donc les deux barres pour de bon, et on remesure à chaque
 * changement (rotation, clavier, pastille qui apparaît).
 * ========================================================================== */
function measureChrome() {
  const topbar = document.getElementById('topbar');
  const css = document.documentElement.style;

  // On ne mesure QUE la barre d'état. La barre d'onglets, elle, tire sa
  // hauteur de --tabbar-h : la mesurer pour réécrire la variable dont elle
  // dépend créerait une boucle qui la ferait grandir à chaque frame.
  const apply = () => {
    const th = Math.round(topbar.getBoundingClientRect().height);
    if (th > 0) css.setProperty('--topbar-h', `${th}px`);
  };

  apply();

  /* Observation en BORDER-BOX, et c'est le point qui compte : les retraits de
   * sécurité de l'appareil — l'encoche — sont posés en PADDING sur la barre. Un
   * ResizeObserver par défaut ne regarde que la boîte de contenu : il ne voit
   * pas un padding qui change, donc pas les 47 px d'encoche qui apparaissent au
   * moment où l'app passe en plein écran ou tourne. */
  const ro = new ResizeObserver(apply);
  try {
    ro.observe(topbar, { box: 'border-box' });
  } catch {
    ro.observe(topbar); // navigateurs antérieurs à l'option box
  }
  ro.observe(document.getElementById('status-chips'));

  // Filet de sécurité : la barre grandit quand les pastilles passent à deux
  // lignes, et le retrait de sécurité n'est parfois appliqué qu'après la
  // première frame utile.
  for (const d of [300, 1200, 3000]) setTimeout(apply, d);
  window.addEventListener('orientationchange', () => setTimeout(apply, 260));
  window.visualViewport?.addEventListener('resize', apply);
}

/**
 * Verrouillage en portrait, une fois installée. Sur un bateau qui gîte, un
 * téléphone posé sur le tableau de bord bascule tout seul en paysage au pire
 * moment — celui où l'on regarde le cap. Le verrou n'est accordé qu'aux apps
 * installées ; ailleurs l'appel échoue sans conséquence.
 */
function lockOrientation() {
  try {
    screen.orientation?.lock?.('portrait').catch(() => {});
  } catch { /* non supporté : le manifeste demande déjà le portrait */ }
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
    state.nav
      ? {
          txt: `🎯 ${state.nav.name}${state.fix ? ` ${fmt.dist(distance(state.fix, state.nav))}` : ''}`,
          cls: 'good',
        }
      : null,
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
    /* Sans GPS, on se rabat sur le port CHOISI dans la cabine avant le port
     * d'attache : quelqu'un qui a réglé Saint-Vaast la veille au soir veut la
     * météo de Saint-Vaast, pas celle de Dieppe, et il n'aura pas de fix tant
     * qu'il n'est pas dehors. */
    const home = places.current() || spots.getPort();
    const pos = state.fix
      ? { lat: state.fix.lat, lon: state.fix.lon }
      : { lat: home.lat, lon: home.lon };

    const wx = await weatherApi.load(pos.lat, pos.lon, { force: !!opts.force });
    set({ weather: wx });

    if (wx.stale && wx.hourly.length) {
      dom.banner(`Météo datant de ${fmt.age(wx.fetchedAt)} — scores calculés dessus.`, 'info', { id: 'stalewx' });
    }

    recompute(pos, wx.hourly);

    // Les alertes météo, sur la prévision qui vient d'arriver. Le tour est
    // local : il ne remplace pas le mail, il fait en sorte que l'alerte
    // fonctionne dès aujourd'hui, sans attendre le serveur d'envoi.
    checkWxAlerts(pos, wx.hourly).catch(() => {});
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
  const sun = sunTimesOfDay(now, pos.lat, pos.lon);
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

/* ==========================================================================
 * Alertes météo — le tour local
 * --------------------------------------------------------------------------
 * Ce que le serveur fera par mail, l'app le fait déjà par notification quand
 * elle tourne. C'est volontairement redondant : une alerte qui n'existe que
 * sur un serveur pas encore branché n'alerte personne, et une fonction qu'on
 * annonce doit marcher le jour où on l'annonce.
 * ========================================================================== */
async function checkWxAlerts(pos, hourly) {
  if (!hourly?.length) return;
  // sunTimesOfDay et non sunTimes : le second découpe ses jours autour de
  // MIDI et renverrait le soleil de la veille pour une heure du matin.
  const sunFor = (t) => sunTimesOfDay(t, pos.lat, pos.lon);

  await wxalert.evaluate({
    hourly,
    sunFor,
    notify: async (rule, win) => {
      const quand = `${fmt.hhmmDay(win.start)} → ${fmt.hhmm(win.end)}`;
      const corps = `${quand} · ${win.hours} h · vent ${Math.round(win.windMaxKn)} nd max`
        + (win.waveMaxM != null ? ` · mer ${win.waveMaxM.toFixed(1)} m` : '');

      // Le bandeau reste à l'écran : un toast de trois secondes sur une bonne
      // nouvelle qu'on attendait depuis dix jours serait raté une fois sur deux.
      dom.banner(`🌤 ${rule.name || 'Fenêtre météo'} — ${corps}`, 'info', { id: `wxa-${rule.id}` });
      navigator.vibrate?.([60, 60, 60]);

      if (!rule.channels?.push) return;
      try {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const reg = await navigator.serviceWorker?.getRegistration?.();
        const opts = {
          body: corps,
          tag: `wxa-${rule.id}`,
          icon: 'assets/icon-180.png',
          badge: 'assets/icon-180.png',
        };
        if (reg?.showNotification) await reg.showNotification(`🌤 ${rule.name || 'Bonne météo'}`, opts);
        else new Notification(`🌤 ${rule.name || 'Bonne météo'}`, opts);
      } catch { /* notifications refusées : le bandeau reste */ }
    },
  });
}

on('data:refresh', (o) => slowTick(o || { force: true }));

// Changer de port change la côte : on retélécharge tout de suite, et la cabine
// se redessine avec ce qu'elle a en attendant la réponse.
on('place:changed', () => {
  slowTick({ force: true });
  if (current === 'nav') VIEWS.nav.refresh?.();
});

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
  /* Le bouton de prise disparaît sur les écrans de conduite. En pilotage il
   * recouvrait l'heure d'arrivée — exactement le chiffre qu'on vient chercher.
   * En mode HORIZON c'est pire : il chevauche la moitié droite du bouton de
   * cadence, et un doigt qui vise le rythme d'un feu enregistrerait un poisson
   * qu'on n'a pas pris. Dans les deux cas on ne pêche pas, on navigue. */
  /* En CONDUITE il reste, et c'est voulu : c'est la seule commande que le mode
   * isolé conserve, parce qu'on pêche en dérivant — donc en conduisant. */
  record.setFabVisible(!['log', 'pilot', 'horizon', 'fish-mode'].includes(name));
  history.replaceState(null, '', `#${name}`);
  set({ view: name });
}

on('goto', showView);

/* ==========================================================================
 * Mode pilotage
 * --------------------------------------------------------------------------
 * Armer une route bascule l'app en pilotage : c'est le seul écran qui compte
 * tant qu'on fait route, et le chercher dans un menu pendant qu'on sort du
 * chenal n'a aucun sens. Le premier onglet change de nom plutôt que d'ajouter
 * un cinquième bouton permanent — la place en bas d'écran est comptée, et un
 * onglet qui ne sert qu'en traversée n'a pas à voler de la largeur au reste.
 * ========================================================================== */
function syncNavTab() {
  const tab = document.getElementById('tab-nav');
  const on = !!state.nav;
  tab.dataset.goto = on ? 'pilot' : 'nav';
  // L'icône n'est plus réécrite ici : la barre à roue est un SVG, et lui
  // affecter du texte l'aurait effacée sans retour. Les deux dessins sont dans
  // le document, `tab-live` choisit lequel se montre.
  tab.querySelector('.tab-lbl').textContent = on ? 'PILOTE' : 'CABINE';
  tab.classList.toggle('tab-live', on);
}

on('nav:start', (nav) => {
  syncNavTab();
  dom.dismissBanner('arrived');
  // Sauf en CONDUITE : ce mode affiche déjà la route, en plus grand, et
  // basculer vers PILOTE ferait sortir du cockpit celui qui vient seulement
  // d'y choisir un but. Un mode isolé qu'on peut quitter sans l'avoir demandé
  // n'est pas isolé.
  if (current !== 'drive') showView('pilot');
  dom.toast(`Route sur ${nav.name}`, 'good');
});

on('nav:stop', () => {
  syncNavTab();
  dom.dismissBanner('arrived');
  // La conduite reste : sans but, elle redevient simplement une conduite
  // libre. C'est le mode qui décide de sa forme, pas la route.
  if (current === 'pilot') showView('nav');
});

on('nav:approach', (a) => {
  navigator.vibrate?.([60, 60, 60]);
  dom.toast(`Approche de ${a.name} — ${Math.round(a.distanceM)} m`, '', 4000);
});

/**
 * L'arrivée. Vibration longue, bip, et un bandeau qui reste : à ce moment-là
 * le regard est dehors, sur l'eau, pas sur l'écran — un toast de deux secondes
 * serait raté neuf fois sur dix.
 */
on('nav:arrived', (a) => {
  navigator.vibrate?.([200, 100, 200, 100, 500]);
  dom.toast(
    a.passed ? `${a.name} — passage au plus près (${Math.round(a.distanceM)} m)` : `Arrivé sur ${a.name}`,
    'good',
    6000,
  );
  dom.dismissBanner('arrived');
  dom.banner(
    `🎯 Arrivé à destination — ${a.name}, à ${Math.round(a.distanceM)} m.`,
    'info',
    { id: 'arrived' },
  );
  if (!['pilot', 'map', 'drive'].includes(current)) showView('pilot');
});

on('nav:offcourse', (o) => {
  navigator.vibrate?.([40, 80, 40]);
  dom.toast(`Écart de route : ${Math.round(o.xteM)} m`, '', 3500);
});

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

  /* SOS. Un seul appui ouvre l'écran de détresse — pas de confirmation, mais
   * pas d'appel automatique non plus : c'est l'écran qui s'ouvre, et le numéro
   * demande un second geste. Un appel aux secours déclenché par un doigt dans
   * une poche coûte cher à tout le monde, et l'écran lui-même ne coûte rien. */
  document.getElementById('btn-sos').addEventListener('click', () => {
    dom.primeAudio();
    sos.openSOS();
  });

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
  // La flotte doit le savoir : un homme à l'eau, c'est le seul cas où la
  // position part même si le partage est éteint.
  emit('mob:set', m);
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
      // Par anchorwatch et non gps.weighAnchor : celui-ci ne vide que la
      // mémoire, et la veille serait ressuscitée au prochain lancement.
      () => { gps.weighAnchor(); anchorwatch.disarm(); },
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

/* ==========================================================================
 * Le garde anti-double-tap
 * --------------------------------------------------------------------------
 * Sur un bateau qui bouge, un doigt qui rebondit ne doit pas déclencher un
 * zoom sur le tableau de bord. D'où ce garde.
 *
 * ── CE QU'IL CASSAIT, ET C'ÉTAIT LE DÉFAUT SIGNALÉ ────────────────────────
 * Il annulait TOUT relâché survenant moins de 320 ms après le précédent, sans
 * regarder si le doigt avait bougé. Or c'est exactement ce que fait un
 * balayage : on pousse la bande, on repose le doigt, on repousse. Le deuxième
 * relâché était annulé, et sur un moteur tactile un `preventDefault` sur le
 * relâché coupe l'inertie — la bande s'arrête net au lieu de continuer. Les
 * bandes horizontales — pastilles d'état, bandeau d'infos, jours de la
 * prévision, filtres du catalogue — étaient toutes touchées.
 *
 * Un double-tap, ce n'est pas deux relâchés rapprochés : c'est deux touchers
 * rapprochés ET IMMOBILES ET AU MÊME ENDROIT. On mesure donc les trois. Le
 * zoom accidentel reste bloqué, le balayage garde son élan.
 *
 * (`touch-action: manipulation` en CSS fait le même travail nativement et sans
 * écouteur ; ce garde reste pour les moteurs qui ne l'honorent pas partout.)
 * ========================================================================== */
const TAP_SLOP = 14;    // px — au-delà, c'est un glissé, pas un tap
const TAP_GAP = 320;    // ms — au-delà, deux gestes distincts

let lastTap = { t: 0, x: 0, y: 0 };
let touchStart = null;

document.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStart = t ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  if (!t) return;
  const now = Date.now();
  const bougé = touchStart
    ? Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > TAP_SLOP
    : true;

  // Un glissé n'est jamais un tap : il ne peut ni être annulé, ni compter
  // comme la première moitié d'un double-tap.
  if (bougé) {
    lastTap = { t: 0, x: 0, y: 0 };
    touchStart = null;
    return;
  }

  const proche = Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= TAP_SLOP * 2;
  if (now - lastTap.t < TAP_GAP && proche) {
    e.preventDefault();
    lastTap = { t: 0, x: 0, y: 0 };   // pas de triple-tap en chaîne
  } else {
    lastTap = { t: now, x: t.clientX, y: t.clientY };
  }
  touchStart = null;
}, { passive: false });

boot();

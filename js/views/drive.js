/* ==========================================================================
 * views/drive.js — MODE CONDUITE
 * --------------------------------------------------------------------------
 * Un cockpit. Pas un écran de plus dans une application à onglets : un mode
 * ISOLÉ, dans lequel on entre en décidant d'y entrer et dont on sort par un
 * bouton franc. Tant qu'on y est, la barre d'onglets disparaît, les bandeaux
 * d'alerte se taisent, les menus n'existent plus. Il ne reste que les
 * instruments, le bouton de prise, et la sortie.
 *
 * ── POURQUOI UN MODE, ET PAS UN ÉCRAN ─────────────────────────────────────
 * Conduire un bateau, ce n'est pas consulter une app. Le regard quitte la mer
 * une demi-seconde, revient, repart. Dans ce budget-là, tout ce qui peut être
 * touché par erreur est un risque, et tout ce qui peut être cherché est du
 * temps volé à la veille. Un mode isolé supprime les deux : il n'y a rien à
 * chercher parce qu'il n'y a rien d'autre, et rien à toucher par erreur parce
 * que rien d'autre n'est touchable.
 *
 * ── CE QUI RESTE, ET POURQUOI ─────────────────────────────────────────────
 * MOB et SOS restent en haut. Un mode « immersif » qui enlève l'appel de
 * détresse est un mode qui tue : l'isolement porte sur les MENUS, jamais sur
 * la sécurité. Le bouton de prise reste aussi — c'est la demande, et c'est
 * cohérent : on pêche en dérivant, donc en conduisant.
 *
 * ── DEUX FAÇONS D'ENTRER ──────────────────────────────────────────────────
 * LIBRE    pas de but. Cap, vitesse, route fond, courant, marée. C'est la
 *          sortie ordinaire : on va « par là », on cherche le poisson.
 * VERS     un but armé — coordonnées dictées à la VHF, une marque, une prise
 *          du journal, le port. Le cockpit ajoute alors le cap à tenir,
 *          l'ordre de barre, l'écart à la route et l'heure d'arrivée.
 * Le même cockpit dans les deux cas : on n'apprend pas deux écrans.
 * ========================================================================== */

import { state, subscribe, on, emit } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from '../ui/dom.js';
import { Compass, CDI } from '../ui/widgets.js';
import * as fmt from '../core/fmt.js';
import * as route from '../nav/route.js';
import * as stream from '../data/stream.js';
import * as tide from '../data/tide.js';
import * as weather from '../data/weather.js';
import * as spots from '../fishing/spots.js';
import { openDestinationPicker } from '../ui/destination.js';

let root;
let unsubs = [];
let widgets = {};
let refs = {};
let timer = 0;
let marks = [];
let enteredAt = 0;
let lock = null;

/* ==========================================================================
 * Entrée dans le mode
 * ========================================================================== */

/**
 * La barre à roue, dessinée. Le même signe que l'onglet NAV, et pour la même
 * raison : c'est le geste de CONDUIRE le bateau qu'on désigne, pas celui de
 * chercher le nord. Aucun émoji ne représente une barre — ☸ est une roue du
 * dharma et n'a pas de poignées, 🛞 est un pneu de voiture. Alors on la
 * dessine, une fois, et tous les boutons du mode s'en servent.
 *
 * @param {number} px Taille en pixels. Le trait s'épaissit avec elle pour que
 *   la roue garde le même poids visuel qu'un émoji de la même hauteur.
 */
export function helmIcon(px = 19) {
  const span = el('span', 'helm-ico');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none"
      stroke="currentColor" stroke-width="${(1.9 * 19 / px).toFixed(2)}" stroke-linecap="round">
      <circle cx="12" cy="12" r="4.1"/>
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>
      <path d="M12 7.9V2.7M12 16.1v5.2M7.9 12H2.7M16.1 12h5.2
               M9.1 9.1 5.4 5.4M14.9 9.1 18.6 5.4M9.1 14.9 5.4 18.6M14.9 14.9l3.7 3.7"/>
    </svg>`;
  return span;
}

/**
 * Le choix d'entrée. Deux boutons pleine largeur, rien d'autre : à quai ou en
 * sortie de chenal, on ne lit pas un formulaire.
 */
export function openDriveChooser() {
  const body = el('div');
  body.append(el('p', 'muted',
    'Le mode conduite masque les onglets et les menus. Il ne reste que les instruments, le bouton de prise et la sortie.'));

  const libre = button('🧭 Navigation libre', 'btn-primary btn-lg', () => {
    // « Libre » veut dire SANS BUT. Entrer en libre avec une route encore
    // armée aurait ouvert un cockpit plein de cap à tenir et d'heure
    // d'arrivée — c'est-à-dire l'inverse de ce qui vient d'être demandé.
    // On lâche donc la route, et le sous-titre du bouton l'annonçait.
    if (state.nav) route.stop();
    closeSheet();
    emit('goto', 'drive');
  });
  libre.append(el('div', 'drive-choice-sub', state.nav
    ? `Sans but — abandonne la route vers ${state.nav.name}.`
    : 'Cap, vitesse, courant et marée. Sans but à atteindre.'));

  const vers = button('🎯 Naviguer vers…', 'btn-lg', () => {
    closeSheet();
    // Le sélecteur existe déjà et sait tout faire : chiffres dictés, marques,
    // prises du journal, port. On ne réécrit pas quatre onglets pour ce mode.
    openDestinationPicker({
      onPick: (dest) => {
        const nav = route.start(dest);
        if (!nav) return void toast('Position invalide', 'danger');
        closeSheet();
        navigator.vibrate?.([20, 40, 20]);
        emit('goto', 'drive');
      },
    });
  });
  vers.append(el('div', 'drive-choice-sub', 'Coordonnées, une marque, une prise, le retour au port.'));

  if (state.nav) {
    const suite = button(`▶︎ Reprendre vers ${state.nav.name}`, 'btn-primary btn-lg', () => {
      closeSheet();
      emit('goto', 'drive');
    });
    body.append(suite);
  }
  body.append(libre, vers);
  return openSheet('Mode conduite', body);
}

/* ==========================================================================
 * Cycle de vie
 * ========================================================================== */
export function mount(container) {
  root = clear(container);
  widgets = {};
  refs = {};
  marks = [];
  enteredAt = Date.now();

  // La classe porte tout l'isolement : onglets, bandeaux, chips secondaires.
  // Elle est posée sur le body et non sur la vue, parce que ce qu'on masque
  // vit HORS de la vue — c'est précisément ce qui fait un mode et pas un écran.
  document.body.classList.add('driving');
  requestLock();

  build();
  unsubs.push(subscribe('heading', renderHeading));
  unsubs.push(subscribe(['fix', 'nav', 'weather'], render));
  unsubs.push(on('nav:stop', () => { rebuild(); }));
  unsubs.push(on('nav:start', () => { rebuild(); }));
  timer = setInterval(render, 1000);
  render();
}

export function unmount() {
  unsubs.forEach((fn) => fn?.());
  unsubs = [];
  clearInterval(timer);
  Object.values(widgets).forEach((w) => w.destroy?.());
  widgets = {};
  refs = {};
  document.body.classList.remove('driving');
  releaseLock();
}

export function refresh() {
  render();
}

/** Le cockpit change de forme entre libre et route armée : on le reconstruit. */
function rebuild() {
  if (!root) return;
  Object.values(widgets).forEach((w) => w.destroy?.());
  widgets = {};
  refs = {};
  build();
  render();
}

/* L'écran ne doit pas s'éteindre pendant qu'on barre. Le verrou est demandé à
 * l'entrée et rendu à la sortie : le garder hors du mode viderait la batterie
 * d'un téléphone posé dans une poche. */
async function requestLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
  } catch { /* refusé, batterie basse : le mode marche quand même */ }
}
function releaseLock() {
  try { lock?.release(); } catch { /* déjà rendu */ }
  lock = null;
}

/* ==========================================================================
 * Construction du cockpit
 * ========================================================================== */
function build() {
  const nav = state.nav;
  const box = clear(root);
  box.classList.add('drive');

  /* ---- Bandeau ---------------------------------------------------------- *
   * Le but à gauche, la sortie à droite. La sortie est un bouton ÉCRIT, pas
   * une croix : on quitte un mode, ce n'est pas la même chose que fermer une
   * fenêtre, et un pictogramme seul se touche par erreur. */
  const head = el('div', 'drive-head');
  const who = el('div', 'drive-who');
  refs.title = el('div', 'drive-title', nav ? nav.name : 'NAVIGATION LIBRE');
  refs.sub = el('div', 'drive-sub', nav ? '' : 'sans but — cap et vitesse');
  who.append(refs.title, refs.sub);
  const out = el('button', 'drive-exit', '');
  out.type = 'button';
  out.append(el('span', 'drive-exit-ico', '⤺'), el('span', null, 'QUITTER'));
  out.setAttribute('aria-label', 'Quitter le mode conduite');
  out.addEventListener('click', leave);
  head.append(who, out);
  box.append(head);

  /* ---- Compas et cap ----------------------------------------------------- *
   * Le compas ne bouge jamais de place. C'est le point d'appui du regard : un
   * instrument qui se déplace entre deux coups d'œil oblige à le chercher, et
   * on cherche mal quand ça bouge. */
  const cap = el('div', 'drive-card');
  const cWrap = el('div');
  cap.append(cWrap);
  widgets.compass = new Compass(cWrap, { height: 94 });

  const capRow = el('div', 'drive-cap');
  const left = el('div');
  refs.hdg = el('div', 'drive-big tnum', '—––°');
  refs.hdgLbl = el('div', 'drive-lbl', 'CAP COMPAS');
  left.append(refs.hdg, refs.hdgLbl);
  const right = el('div');
  right.style.textAlign = 'right';
  refs.cts = el('div', 'drive-big tnum c-cyan', '—––°');
  refs.ctsLbl = el('div', 'drive-lbl', nav ? 'CAP À TENIR' : 'ROUTE FOND');
  right.append(refs.cts, refs.ctsLbl);
  capRow.append(left, el('div', 'spacer'), right);
  cap.append(capRow);
  box.append(cap);

  /* ---- Ordre de barre — seulement avec un but ---------------------------- *
   * « 12° à droite », pas un écart à interpréter. C'est la seule ligne du
   * cockpit qui donne un ORDRE, elle a donc sa propre bande et sa couleur. */
  if (nav) {
    refs.steer = el('div', 'drive-steer', '—');
    box.append(refs.steer);
  }

  /* ---- Vitesse ----------------------------------------------------------- *
   * En très gros, parce qu'elle décide de tout le reste : l'heure d'arrivée,
   * la tenue de la route, et si l'on peut remonter le courant. */
  const spd = el('div', 'drive-card drive-speed');
  refs.sog = el('div', 'drive-huge tnum', '—');
  refs.sogUnit = el('div', 'drive-unit', 'NŒUDS FOND');
  spd.append(refs.sog, refs.sogUnit);
  refs.sogNote = el('div', 'drive-note', '');
  spd.append(refs.sogNote);
  box.append(spd);

  /* ---- Trois chiffres ---------------------------------------------------- *
   * Avec un but : combien il reste, en distance, en temps, et à quelle heure.
   * Sans but : ce qu'on a fait, depuis combien de temps, et quand le courant
   * s'arrête — les trois questions qu'on se pose vraiment en dérive. */
  const grid = el('div', 'drive-grid');
  const cell = (lbl, cls) => {
    const c = el('div', 'drive-card drive-cell');
    const v = el('div', `drive-mid tnum ${cls}`, '—');
    const l = el('div', 'drive-lbl', lbl);
    c.append(v, l);
    grid.append(c);
    return { v, l };
  };
  if (nav) {
    refs.dtg = cell('DISTANCE', 'c-lime').v;
    refs.ttg = cell('RESTANT', '').v;
    refs.eta = cell('ARRIVÉE', 'c-amber').v;
  } else {
    refs.run = cell('PARCOURU', 'c-lime').v;
    const d = cell('EN ROUTE', '');
    refs.dur = d.v;
    refs.durLbl = d.l;
    refs.slack = cell('ÉTALE', 'c-amber').v;
  }
  box.append(grid);

  /* ---- Écart à la route -------------------------------------------------- *
   * Sous les chiffres, et c'est un ordre de lecture, pas un reste : l'écart
   * est un instrument de CONTRÔLE, pas de commande. On barre sur l'ordre de
   * barre, on vérifie sur l'écart. Mesuré sur iPhone SE, les cinq blocs
   * au-dessus tiennent dans l'écran sans défiler — l'écart et la mer se
   * consultent, ils peuvent demander un pouce. */
  if (nav) {
    const cdi = el('div', 'drive-card');
    const w = el('div');
    cdi.append(w);
    widgets.cdi = new CDI(w, { height: 44 });
    refs.xte = el('div', 'drive-note');
    cdi.append(refs.xte);
    box.append(cdi);
  }

  /* ---- Mer et ciel ------------------------------------------------------- *
   * Courant, marée, vent. Trois lignes qu'on ne pilote pas mais qui décident
   * de la manœuvre — et qu'on n'a plus le droit d'aller chercher ailleurs,
   * puisque les onglets n'existent plus dans ce mode. */
  refs.sea = el('div', 'drive-sea');
  box.append(refs.sea);

  /* ---- Deux commandes, pas une de plus ----------------------------------- */
  const acts = el('div', 'drive-acts');
  if (nav) {
    acts.append(button('🎯 Autre but', '', () => openDestinationPicker()));
    acts.append(button('✕ Route', '', () => {
      route.stop();
      toast('Navigation arrêtée — conduite libre', 'good');
    }));
  } else {
    acts.append(button('🎯 Choisir un but', 'btn-primary', () => openDestinationPicker()));
  }
  box.append(acts);

  refs.arrival = el('div');
  box.append(refs.arrival);
}

/**
 * Sortie du mode. Elle ne demande rien : quitter un mode d'affichage n'a
 * aucune conséquence — la route armée reste armée, la sortie en cours reste
 * en cours. Une confirmation ici ferait perdre un aller-retour de regard pour
 * protéger quelque chose qui n'a pas besoin de l'être.
 */
function leave() {
  navigator.vibrate?.(12);
  emit('goto', state.nav ? 'pilot' : 'nav');
}

/* ==========================================================================
 * Rendu du compas — chemin chaud, cadence du magnétomètre
 * ========================================================================== */
function renderHeading() {
  if (!widgets.compass) return;
  const hd = state.heading;
  const deg = hd?.deg ?? state.fix?.cogDeg;
  if (Number.isFinite(deg)) widgets.compass.set(deg, marks, hd?.quality || 'good');
  if (refs.hdg) {
    refs.hdg.textContent = fmt.heading(deg);
    refs.hdgLbl.textContent = state.heading?.source === 'compass' ? 'CAP COMPAS' : 'ROUTE GPS';
  }
}

/* ==========================================================================
 * Rendu complet — 1 Hz
 * ========================================================================== */
function render() {
  if (!root || !refs.title) return;
  const now = Date.now();
  const fix = state.fix;
  const nav = state.nav;
  const pos = fix || spots.getPort();
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;

  /* ---- Vitesse ----------------------------------------------------------- */
  refs.sog.textContent = fix?.speedKn != null ? fmt.num(fix.speedKn, 1) : '—';

  /* ---- Mer et ciel ------------------------------------------------------- */
  const st = stream.tidalStream(now, pos);
  const sea = clear(refs.sea);
  const seaLine = (k, v) => {
    const r = el('div', 'drive-sea-row');
    r.append(el('span', 'drive-sea-k', k), el('span', 'drive-sea-v tnum', v));
    sea.append(r);
  };
  seaLine('Courant', `${fmt.num(st.spd, 1)} nd → ${fmt.heading(st.dir)} ${fmt.cardinal(st.dir)}`);
  seaLine('Marée', `${fmt.num(tide.height(now), 1)} m · ${tide.rate(now) >= 0 ? 'montante' : 'descendante'}`);
  if (wx) seaLine('Vent', `${fmt.windFrom(wx.windDirDeg)} · ${Math.round(wx.windSpeedKn)} nd`);

  if (!nav) return void renderFree(now, fix, st);
  renderRoute(now);
}

/* --------------------------------------------------------------------------
 * Conduite libre
 * ------------------------------------------------------------------------ */
function renderFree(now, fix, st) {
  refs.cts.textContent = fmt.heading(fix?.cogDeg);
  refs.sogNote.textContent = fix?.moving
    ? `route fond ${fmt.heading(fix.cogDeg)} · précision ±${Math.round(fix.accuracy || 0)} m`
    : 'bateau immobile ou dérivant lentement';

  // « Parcouru » suit la sortie si elle est ouverte, sinon le temps passé dans
  // le cockpit. Deux compteurs différents auraient été deux vérités : on
  // affiche celui qui existe, et on dit lequel.
  const trip = state.trip;
  refs.run.textContent = trip ? fmt.dist(trip.distanceM) : '—';
  refs.dur.textContent = fmt.duration(now - (trip?.startedAt || enteredAt));
  refs.durLbl.textContent = trip ? 'SORTIE' : 'EN ROUTE';
  refs.slack.textContent = st.slackT ? fmt.hhmm(st.slackT) : '—';
}

/* --------------------------------------------------------------------------
 * Conduite vers un but
 * ------------------------------------------------------------------------ */
function renderRoute(now) {
  const sol = route.solve(now);
  if (!sol) return;

  refs.title.textContent = state.nav.name;

  marks = sol.ok
    ? [
        { deg: sol.bearingDeg, color: '#a3e635', label: 'BUT' },
        { deg: sol.ctsDeg, color: '#22d3ee', label: 'CAP' },
      ]
    : [];
  renderHeading();

  if (!sol.ok) {
    refs.sub.textContent = 'en attente de position GPS';
    refs.cts.textContent = '—––°';
    refs.steer.textContent = '—';
    refs.dtg.textContent = refs.ttg.textContent = refs.eta.textContent = '—';
    return;
  }

  refs.sub.textContent = `relèvement ${fmt.heading(sol.bearingDeg)} · ${fmt.dist(sol.distanceM)}`;
  refs.cts.textContent = fmt.heading(sol.ctsDeg);

  /* La couleur suit l'écart — mais un ordre INCONNU ne se peint pas en vert.
   * Tant que le bateau ne bouge pas, `turnDeg` est nul et le cockpit annonçait
   * « — » sur fond vert, c'est-à-dire « tu es dans l'axe » alors qu'il n'en
   * savait rien. Un instrument muet doit avoir l'air muet. */
  const turn = sol.turnDeg;
  const off = Math.abs(turn ?? 0);
  refs.steer.textContent = route.steerLabel(turn);
  refs.steer.className = `drive-steer ${
    !Number.isFinite(turn) ? '' : off <= 3 ? 'ok' : off <= 15 ? 'warn' : 'bad'}`;

  widgets.cdi.set(sol.xteM);
  refs.xte.textContent = route.xteLabel(sol.xteM);

  refs.dtg.textContent = fmt.dist(sol.distanceM);
  refs.ttg.textContent = sol.ttgMs != null ? fmt.duration(sol.ttgMs) : '—';
  refs.eta.textContent = sol.etaT != null ? fmt.hhmm(sol.etaT) : '—';

  refs.sogNote.textContent = sol.vmgKn > 0.4 && sol.sogKn > 0.4
    ? `${fmt.num(sol.vmgKn, 1)} nd vers le but · ${Math.round((sol.vmgKn / sol.sogKn) * 100)} % utile`
    : `estimation à ${fmt.num(sol.stwKn, 1)} nd surface tant que le bateau ne bouge pas`;

  /* Les deux seuls avertissements qui changent la conduite à cette seconde.
     Tout le reste — marée à l'arrivée, coucher du soleil — appartient à la
     préparation, pas au moment où l'on tient la barre. */
  const warn = clear(refs.arrival);
  if (!sol.holdable) {
    warn.append(el('div', 'drive-alert bad',
      'Dérive supérieure à ta vitesse : cette route ne peut pas être tenue.'));
  } else if (state.nav.phase === 'approach') {
    warn.append(el('div', 'drive-alert ok',
      `Approche — ${Math.round(sol.distanceM)} m. Réduis l’allure, veille visuelle.`));
  } else if (state.nav.phase === 'arrived') {
    warn.append(el('div', 'drive-alert ok', `ARRIVÉ · ${state.nav.name}`));
  }
}

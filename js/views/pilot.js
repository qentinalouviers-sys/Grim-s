/* ==========================================================================
 * views/pilot.js — mode PILOTAGE
 * --------------------------------------------------------------------------
 * L'écran qu'on regarde une main sur la barre, l'autre sur les gaz, avec du
 * sel sur la vitre. Il ne contient que ce qui sert à TENIR UNE ROUTE, et rien
 * d'autre : ni marée, ni scoring, ni conseil de pêche. Tout ce qui n'aide pas
 * à barrer, à cette seconde, est du bruit — et le bruit coûte des secondes de
 * regard baissé.
 *
 * Hiérarchie, du haut vers le bas, dans l'ordre où on les consulte :
 *   1. CAP À TENIR — le seul chiffre qu'on répète à voix haute
 *   2. l'ordre de barre — « 12° à droite », pas un écart à interpréter
 *   3. l'écart à la route — l'instrument de contrôle, pas de commande
 *   4. distance, durée, heure d'arrivée
 *   5. la vitesse, parce qu'elle décide de tout le reste
 *
 * Le compas reste en haut et ne bouge jamais de place : c'est le point d'appui
 * du regard. Un instrument qui se déplace entre deux coups d'œil oblige à le
 * chercher, et on cherche mal quand ça bouge.
 * ========================================================================== */

import { state, subscribe, on, set, emit } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from '../ui/dom.js';
import { Gauge, Compass, CDI } from '../ui/widgets.js';
import * as fmt from '../core/fmt.js';
import * as route from '../nav/route.js';
import * as spots from '../fishing/spots.js';
import { openDestinationPicker } from '../ui/destination.js';
import { helmIcon } from './drive.js';

let root;
let unsubs = [];
let widgets = {};
let refs = {};
let timer = 0;
let marks = [];

export function mount(container) {
  root = clear(container);
  widgets = {};
  refs = {};

  if (!state.nav) {
    root.append(idleScreen());
    return;
  }
  build();
  unsubs.push(subscribe('heading', renderHeading));
  unsubs.push(subscribe(['fix', 'nav', 'weather'], render));
  timer = setInterval(render, 1000);
  render();
}

export function unmount() {
  unsubs.forEach((fn) => fn());
  unsubs = [];
  clearInterval(timer);
  Object.values(widgets).forEach((w) => w.destroy?.());
  widgets = {};
  refs = {};
}

export function refresh() {
  if (state.nav && !refs.head) {
    unmount();
    mount(root);
  }
}

/* --------------------------------------------------------------------------
 * Écran sans route active
 * ------------------------------------------------------------------------ */
function idleScreen() {
  const box = el('div', 'card');
  box.append(el('div', 'list-title', 'Aucune route active'));
  box.append(el('p', 'muted', 'Choisis un but : des coordonnées saisies au clavier, une de tes marques, une prise de ton journal, ou le retour au port.'));
  box.append(button('🎯 Choisir une destination', 'btn-primary btn-lg', () => openDestinationPicker()));
  // Ou pas de but du tout : on sort, on verra sur l'eau. Le cockpit sait faire.
  const libre = button('Navigation libre, sans but', 'btn-lg', () => emit('goto', 'drive'));
  libre.prepend(helmIcon(19));
  libre.style.marginTop = '8px';
  box.append(libre);
  return box;
}

/* --------------------------------------------------------------------------
 * Construction
 * ------------------------------------------------------------------------ */
function build() {
  /* ---- Bandeau de but --------------------------------------------------- */
  const head = el('div', 'card tight pilot-head');
  const main = el('div', 'list-main');
  refs.destName = el('div', 'list-title', state.nav.name);
  refs.destSub = el('div', 'list-sub', '');
  main.append(refs.destName, refs.destSub);
  const stopBtn = el('button', 'icon-btn danger', '✕');
  stopBtn.type = 'button';
  stopBtn.setAttribute('aria-label', 'Arrêter la navigation');
  stopBtn.addEventListener('click', confirmStop);
  head.append(main, stopBtn);
  refs.head = head;
  root.append(head);

  /* ---- Compas ----------------------------------------------------------- */
  const compassCard = el('div', 'card tight');
  const cWrap = el('div');
  compassCard.append(cWrap);
  widgets.compass = new Compass(cWrap, { height: 108 });

  const capRow = el('div', 'pilot-cap');
  const capBox = el('div');
  refs.cts = el('div', 'metric-val c-cyan tnum', '—––°');
  capBox.append(refs.cts, el('div', 'metric-lbl', 'CAP À TENIR'));
  const steerBox = el('div');
  steerBox.style.textAlign = 'right';
  refs.steer = el('div', 'metric-val sm tnum', '—');
  refs.steerSub = el('div', 'metric-lbl', 'ORDRE DE BARRE');
  steerBox.append(refs.steer, refs.steerSub);
  capRow.append(capBox, el('div', 'spacer'), steerBox);
  compassCard.append(capRow);
  root.append(compassCard);

  /* ---- Distance / durée / heure ----------------------------------------
   * Juste sous le cap : ce sont les trois chiffres qu'on donne à l'équipage
   * quand il demande « on arrive quand ? », et ils doivent tenir au-dessus de
   * la ligne de pliage sur un téléphone de 4,7 pouces. */
  const grid = el('div', 'pilot-grid');
  const mkCell = (lbl, cls) => {
    const c = el('div', 'card tight metric');
    const v = el('div', `metric-val sm tnum ${cls}`, '—');
    c.append(v, el('div', 'metric-lbl', lbl));
    grid.append(c);
    return v;
  };
  refs.dtg = mkCell('DISTANCE', 'c-lime');
  refs.ttg = mkCell('RESTANT', '');
  refs.eta = mkCell('ARRIVÉE', 'c-amber');
  root.append(grid);

  /* ---- Écart de route --------------------------------------------------- */
  const cdiCard = el('div', 'card tight');
  const cdiWrap = el('div');
  cdiCard.append(cdiWrap);
  widgets.cdi = new CDI(cdiWrap, { height: 54 });
  refs.xte = el('div', 'tiny');
  refs.xte.style.textAlign = 'center';
  cdiCard.append(refs.xte);
  root.append(cdiCard);

  /* ---- Vitesse ---------------------------------------------------------- */
  const spdCard = el('div', 'card tight pilot-speed');
  const gWrap = el('div', 'gauge-wrap');
  spdCard.append(gWrap);
  widgets.speed = new Gauge(gWrap, { size: 116, max: 12, color: '#22d3ee', unit: 'nd', decimals: 1 });
  const spdInfo = el('div');
  spdInfo.style.flex = '1';
  refs.vmg = el('div', 'metric-val sm tnum', '—');
  refs.vmgLbl = el('div', 'metric-lbl', 'VITESSE VERS LE BUT');
  refs.spdNote = el('div', 'tiny');
  spdInfo.append(refs.vmg, refs.vmgLbl, refs.spdNote);
  spdCard.append(spdInfo);
  root.append(spdCard);

  /* ---- Intelligence ----------------------------------------------------- *
   * Une seule carte, deux ou trois lignes : la correction de dérive appliquée,
   * et ce qu'on trouvera sur le point à l'heure d'arrivée. C'est le seul
   * endroit du mode pilotage où l'on parle encore de courant et de marée —
   * parce que ça change la manœuvre d'arrivée, pas parce que c'est joli. */
  refs.smart = el('div', 'card tight');
  root.append(refs.smart);

  /* ---- Actions ---------------------------------------------------------- *
   * Le passage en navigation vit ICI, et il a fallu s'en apercevoir : dès qu'une
   * route est armée, le premier onglet devient PILOTE et l'écran NAV — donc le
   * bouton d'entrée du mode navigation — n'est plus atteignable. Le cockpit
   * devenait inaccessible exactement au moment où il sert. */
  const toDrive = button('Passer en mode navigation', 'btn-primary btn-lg', () => emit('goto', 'drive'));
  toDrive.prepend(helmIcon(21));
  root.append(toDrive);

  const acts = el('div', 'btn-row');
  acts.style.margin = '8px 0';
  acts.append(
    button('🎯 Autre but', '', () => openDestinationPicker()),
    button('↺ Recaler la route', '', () => {
      route.resetLeg();
      toast('Route recalée sur ta position', 'good');
      render();
    }),
    button('⚙︎', '', openSettings),
  );
  root.append(acts);

  refs.arrival = el('div');
  root.append(refs.arrival);

  root.append(el('div', 'tiny', 'Le cap à tenir compense la dérive calculée (courant de marée + fardage). Il ne remplace ni la veille visuelle, ni la carte marine officielle.'));
}

/* --------------------------------------------------------------------------
 * Rendu du compas — chemin chaud, appelé au rythme du magnétomètre
 * ------------------------------------------------------------------------ */
function renderHeading() {
  if (!widgets.compass) return;
  const hd = state.heading;
  const deg = hd?.deg ?? state.fix?.cogDeg;
  if (Number.isFinite(deg)) widgets.compass.set(deg, marks, hd?.quality || 'good');
}

/* --------------------------------------------------------------------------
 * Rendu complet — 1 Hz
 * ------------------------------------------------------------------------ */
function render() {
  if (!state.nav) {
    // La route vient d'être arrêtée depuis un autre écran.
    unmount();
    clear(root).append(idleScreen());
    return;
  }
  if (!refs.head) return;

  const sol = route.solve();
  if (!sol) return;

  refs.destName.textContent = state.nav.name;

  /* --- Relèvements portés sur le cadran --------------------------------- */
  marks = sol.ok
    ? [
        { deg: sol.bearingDeg, color: '#a3e635', label: 'BUT' },
        { deg: sol.ctsDeg, color: '#22d3ee', label: 'CAP' },
      ]
    : [];
  renderHeading();

  if (!sol.ok) {
    refs.destSub.textContent = 'En attente de position GPS…';
    refs.cts.textContent = '—––°';
    refs.steer.textContent = '—';
    refs.dtg.textContent = refs.ttg.textContent = refs.eta.textContent = '—';
    clear(refs.smart).append(el('div', 'banner warn', 'Pas de position : la navigation reprendra dès le premier fix.'));
    return;
  }

  /* --- Cap et ordre de barre -------------------------------------------- */
  refs.cts.textContent = fmt.heading(sol.ctsDeg);
  refs.steer.textContent = route.steerLabel(sol.turnDeg);
  const off = Math.abs(sol.turnDeg ?? 0);
  refs.steer.className = `metric-val sm tnum ${off <= 3 ? 'c-lime' : off <= 15 ? 'c-amber' : 'c-red'}`;
  refs.steerSub.textContent = state.heading?.source === 'compass' ? 'ORDRE DE BARRE (COMPAS)' : 'ORDRE DE BARRE (ROUTE GPS)';

  // Un point saisi au clavier a pour nom ses propres coordonnées : les répéter
  // sous le titre occupe une ligne pour ne rien apprendre.
  const posTxt = fmt.posDDM(sol.dest);
  refs.destSub.textContent =
    (state.nav.name === posTxt ? '' : `${posTxt} · `)
    + `relèvement ${fmt.heading(sol.bearingDeg)} (${fmt.cardinal(sol.bearingDeg)})`;

  /* --- Écart de route ---------------------------------------------------- */
  widgets.cdi.set(sol.xteM);
  refs.xte.textContent = route.xteLabel(sol.xteM);

  /* --- Distance / temps / heure ----------------------------------------- */
  refs.dtg.textContent = fmt.dist(sol.distanceM);
  refs.ttg.textContent = sol.ttgMs != null ? fmt.duration(sol.ttgMs) : '—';
  refs.eta.textContent = sol.etaT != null ? fmt.hhmm(sol.etaT) : '—';

  /* --- Vitesse ----------------------------------------------------------- */
  widgets.speed.set(sol.sogKn);
  refs.vmg.textContent = `${fmt.num(Math.max(0, sol.vmgKn || sol.sogPredictedKn), 1)} nd`;
  refs.vmgLbl.textContent = sol.vmgKn > 0.4 ? 'VITESSE VERS LE BUT' : 'VITESSE FOND PRÉVUE';
  refs.spdNote.textContent = sol.vmgKn > 0.4 && sol.sogKn > 0.4
    ? `Vitesse fond ${fmt.num(sol.sogKn, 1)} nd · ${Math.round((sol.vmgKn / sol.sogKn) * 100)} % utile`
    : `Estimation à ${fmt.num(sol.stwKn, 1)} nd surface tant que le bateau ne bouge pas.`;

  renderSmart(sol);
  renderArrival(sol);
}

/* --------------------------------------------------------------------------
 * Ce que le pilote ne peut pas deviner
 * ------------------------------------------------------------------------ */
function renderSmart(sol) {
  const box = clear(refs.smart);

  const line = (k, v, cls = '') => {
    const r = el('div', 'row');
    r.style.justifyContent = 'space-between';
    r.style.padding = '2px 0';
    r.append(el('span', 'tiny', k), el('span', `tnum ${cls}`, v));
    r.lastChild.style.fontSize = '13px';
    r.lastChild.style.fontWeight = '650';
    box.append(r);
  };

  const corr = Math.round(sol.driftAngleDeg);
  line(
    'Correction de dérive',
    Math.abs(corr) < 1 ? 'aucune' : `${corr > 0 ? '+' : ''}${corr}° (${fmt.num(sol.drift.spd, 1)} nd de dérive)`,
    Math.abs(corr) > 12 ? 'c-amber' : '',
  );

  if (sol.atArrival) {
    const a = sol.atArrival;
    line('Marée à l’arrivée', `${fmt.num(a.tideM, 1)} m (${a.tideDeltaM >= 0 ? '+' : ''}${fmt.num(a.tideDeltaM, 1)} m)`);
    line('Courant sur le point', `${fmt.num(a.stream.spd, 1)} nd ${fmt.cardinal(a.stream.dir)}`);
  }

  /* Avertissements — rares, donc lisibles quand ils sortent. */
  if (!sol.holdable) {
    box.append(el('div', 'banner danger',
      'Dérive supérieure à ta vitesse : cette route ne peut pas être tenue. Remonte au moteur ou attends l’étale.'));
  } else if (sol.atArrival?.afterSunset && sol.ttgMs > 10 * 60000) {
    box.append(el('div', 'banner warn',
      `Arrivée après le coucher du soleil (${fmt.hhmm(sol.atArrival.sunsetT)}). Prépare les feux et l’éclairage de pont.`));
  } else if (sol.ttgMs != null && sol.ttgMs > 6 * 3600000) {
    box.append(el('div', 'banner warn', 'Plus de six heures de route à cette allure — vérifie le but.'));
  }
}

/* --------------------------------------------------------------------------
 * Arrivée
 * --------------------------------------------------------------------------
 * Le message d'arrivée doit être impossible à rater UNE fois, puis se taire :
 * une bannière clignotante pendant qu'on manœuvre au milieu des casiers est
 * un danger, pas une aide. On affiche donc un panneau franc, avec les seules
 * actions qui ont un sens à cet instant.
 * ------------------------------------------------------------------------ */
function renderArrival(sol) {
  const box = clear(refs.arrival);
  const nav = state.nav;

  if (nav.phase === 'approach') {
    const b = el('div', 'banner info');
    b.append(el('span', null, `Approche — ${Math.round(sol.distanceM)} m. Réduis l’allure et prends la veille visuelle.`));
    box.append(b);
    return;
  }
  if (nav.phase !== 'arrived') return;

  const panel = el('div', 'arrival-card');
  panel.append(el('div', 'arrival-ico', '🎯'));
  panel.append(el('h2', null, 'ARRIVÉ À DESTINATION'));
  panel.append(el('div', 'list-title', nav.name));
  panel.append(el('div', 'list-sub',
    `Approche à ${Math.round(nav.arrivedDistM ?? 0)} m · trajet ${fmt.duration((nav.arrivedAt || Date.now()) - nav.startedAt)}`));

  const acts = el('div', 'btn-row');
  acts.style.marginTop = '12px';
  acts.append(
    button('Terminer', 'btn-primary', () => {
      route.stop();
      toast('Navigation terminée', 'good');
    }),
    button('📍 Marquer ici', '', async () => {
      const p = state.fix || nav;
      await spots.addSpot({ name: nav.name, lat: p.lat, lon: p.lon, note: 'Point atteint en navigation.' });
      toast('Repère enregistré', 'good');
    }),
  );
  panel.append(acts);
  box.append(panel);
}

/* --------------------------------------------------------------------------
 * Réglages de la route
 * ------------------------------------------------------------------------ */
function openSettings() {
  const nav = state.nav;
  if (!nav) return;
  const body = el('div');

  const f1 = el('div', 'field');
  f1.append(el('label', null, 'Rayon d’arrivée (mètres)'));
  const radius = document.createElement('input');
  radius.type = 'number';
  radius.inputMode = 'numeric';
  radius.min = '5';
  radius.max = '500';
  radius.value = String(nav.arrivalRadiusM);
  f1.append(radius);
  body.append(f1);
  body.append(el('p', 'tiny', 'Sous 10 m on est dans le bruit du GPS : l’arrivée se déclenche aussi au passage du travers du point, même si le cercle n’a pas été touché.'));

  const f2 = el('div', 'field');
  f2.append(el('label', null, 'Vitesse de croisière (nœuds)'));
  const cruise = document.createElement('input');
  cruise.type = 'number';
  cruise.inputMode = 'decimal';
  cruise.min = '1';
  cruise.max = '40';
  cruise.step = '0.5';
  cruise.value = String(nav.cruiseKn);
  f2.append(cruise);
  body.append(f2);
  body.append(el('p', 'tiny', 'Sert à estimer l’heure d’arrivée et le cap à tenir tant que le bateau n’a pas pris son allure.'));

  body.append(button('Enregistrer', 'btn-primary btn-lg', () => {
    route.setArrivalRadius(Number(radius.value) || route.DEFAULT_ARRIVAL_M);
    const kn = Math.max(1, Math.min(40, Number(String(cruise.value).replace(',', '.')) || route.DEFAULT_CRUISE_KN));
    set({ nav: { ...state.nav, cruiseKn: kn } });
    closeSheet();
    render();
  }));

  openSheet('Réglages de route', body);
}

function confirmStop() {
  const body = el('div');
  body.append(el('p', 'muted', `Arrêter la navigation vers ${state.nav?.name} ?`));
  body.append(button('Arrêter', 'btn-danger btn-lg', () => {
    route.stop();
    closeSheet();
  }));
  body.append(button('Continuer', 'btn-ghost btn-lg', closeSheet));
  openSheet('Navigation', body);
}

/* Le mode pilotage se referme tout seul quand la route s'arrête ailleurs. */
on('nav:stop', () => {
  if (!root) return;
  unmount();
  clear(root).append(idleScreen());
});

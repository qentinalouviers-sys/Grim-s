/* ==========================================================================
 * views/fishmode.js — MODE PÊCHE
 * --------------------------------------------------------------------------
 * Le pendant du mode conduite, pour l'autre moitié de la sortie. On y entre
 * en le décidant, on en sort par un bouton franc, et pendant ce temps la
 * barre d'onglets et les menus n'existent plus.
 *
 * ── CE QU'ON FAIT VRAIMENT QUAND ON DÉRIVE ────────────────────────────────
 * Trois gestes, et trois seulement :
 *   1. on regarde OÙ le bateau dérive, pour refaire la même dérive après ;
 *   2. on note « ça a touché ICI » — même sans poisson, surtout sans poisson,
 *      parce que c'est l'information qu'on n'a jamais et qu'on voudrait ;
 *   3. on note le poisson monté à bord.
 * Tout le reste — marée, courant, couleur d'eau, montage — sert à décider
 * AVANT, ou à comprendre APRÈS. Ça se lit, ça ne se touche pas.
 *
 * Donc : la carte en haut, deux gros boutons dessous, les conseils encore
 * dessous. Aucun bouton ne flotte au-dessus de la carte sauf le réglage, qui
 * est petit et dans un coin — parce que ce qu'on est venu voir, c'est la
 * trace de la dérive, et un bouton posé dessus la cache exactement là où elle
 * devient intéressante.
 *
 * ── POUR LE DÉBUTANT COMME POUR L'HABITUÉ ─────────────────────────────────
 * Le débutant a besoin qu'on lui dise quoi accrocher et où chercher : c'est le
 * panneau de conseils, écrit en clair, par espèce visée. L'habitué a besoin
 * qu'on ne lui prenne pas l'écran : c'est le panneau de réglages, où chaque
 * compteur s'allume et s'éteint. Le même mode sert les deux parce qu'il ne
 * choisit pas à leur place.
 * ========================================================================== */

import { state, subscribe, on, emit } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from '../ui/dom.js';
import * as fmt from '../core/fmt.js';
import * as idb from '../core/idb.js';
import * as stream from '../data/stream.js';
import * as tide from '../data/tide.js';
import * as weather from '../data/weather.js';
import * as seabed from '../data/seabed.js';
import * as spots from '../fishing/spots.js';
import * as traces from '../fishing/traces.js';
import * as live from '../fishing/live.js';
import * as lures from '../fishing/lures.js';
import * as record from '../fishing/record.js';
import * as catalog from '../fishing/catalog.js';

const LEAFLET_JS = 'vendor/leaflet/leaflet.js';
const LEAFLET_CSS = 'vendor/leaflet/leaflet.css';
const KEY_PREFS = 'fish-mode-prefs';

let root;
let L = null;
let map = null;
let layers = {};
let refs = {};
let unsubs = [];
let timer = 0;
let started = 0;
let caught = 0;

/* La session : ce qu'on a choisi au lancement. Elle ne survit pas à la sortie
 * du mode — une sortie de pêche, ça se rejoue, ça ne se reprend pas. */
let session = { targets: [], skyId: null, waterId: null };

/* Ce que le panneau affiche. Chaque ligne s'allume et s'éteint dans les
 * réglages, et le choix se garde : celui qui a éteint le coefficient de marée
 * ne veut pas le rallumer à chaque sortie. */
const PANELS = [
  { id: 'derive', name: 'Dérive du bateau', hint: 'vitesse et direction réelles', on: true },
  { id: 'trace', name: 'Dérive en cours', hint: 'longueur et durée depuis le lancement', on: true },
  { id: 'maree', name: 'Marée', hint: 'hauteur, sens, coefficient', on: true },
  { id: 'courant', name: 'Courant de marée', hint: 'vitesse, direction, étale', on: true },
  { id: 'fond', name: 'Nature du fond', hint: 'sable, roche, gravier sous le bateau', on: true },
  { id: 'vent', name: 'Vent', hint: 'secteur et force', on: true },
  { id: 'eau', name: 'Température de l’eau', hint: '', on: false },
  { id: 'prises', name: 'Compteur de prises', hint: 'de cette sortie', on: true },
  { id: 'heure', name: 'Heure et durée', hint: '', on: false },
];
let prefs = {};

/* ==========================================================================
 * Lancement
 * ========================================================================== */

/**
 * L'écran de lancement. Deux questions, dans cet ordre : ce qu'on cherche,
 * et ce qu'on voit. La couleur du ciel et de l'eau est FACULTATIVE et le
 * bouton le dit — mais elle est demandée en premier plan parce que c'est
 * elle qui transforme un conseil générique en conseil du jour.
 */
export async function openFishChooser() {
  await ensurePrefs();
  const body = el('div');
  const pick = { skyId: null, waterId: null, targets: [] };

  /* ---- Couleur du ciel et de l'eau -------------------------------------- */
  body.append(el('div', 'fm-step', '1 · Ce que tu vois'));
  body.append(el('p', 'tiny', 'Facultatif, mais c’est ce qui choisit la couleur du leurre. Deux touches.'));

  const skyRow = el('div', 'fm-swatches');
  for (const s of lures.SKIES) {
    const b = swatch(s.emoji, s.name, s.swatch, () => {
      pick.skyId = pick.skyId === s.id ? null : s.id;
      paintSwatches();
      paintAdvicePreview();
    });
    b.dataset.id = s.id;
    skyRow.append(b);
  }
  body.append(el('div', 'fm-sub', 'Le ciel'), skyRow);

  const waterRow = el('div', 'fm-swatches');
  for (const w of lures.WATERS) {
    const b = swatch(w.emoji || '💧', w.name, w.swatch, () => {
      pick.waterId = pick.waterId === w.id ? null : w.id;
      paintSwatches();
      paintAdvicePreview();
    });
    b.dataset.id = w.id;
    waterRow.append(b);
  }
  body.append(el('div', 'fm-sub', 'L’eau'), waterRow);

  const preview = el('div', 'fm-preview');
  body.append(preview);

  function paintSwatches() {
    for (const b of skyRow.children) b.classList.toggle('on', b.dataset.id === pick.skyId);
    for (const b of waterRow.children) b.classList.toggle('on', b.dataset.id === pick.waterId);
  }
  function paintAdvicePreview() {
    clear(preview);
    if (!pick.skyId || !pick.waterId) {
      preview.append(el('div', 'tiny', 'Choisis un ciel ET une eau pour voir la couleur conseillée. Sinon on passe : les conseils resteront valables, simplement moins précis.'));
      return;
    }
    const cond = lures.conditions({ skyId: pick.skyId, waterId: pick.waterId, depthM: 12, currentKn: driftKn() });
    const top = lures.rank(cond, { limit: 3 });
    const row = el('div', 'fm-lures');
    for (const r of top) {
      const c = el('div', 'fm-lure');
      const dot = el('span', 'fm-lure-dot');
      dot.style.background = r.colour.hex;
      c.append(dot, el('span', null, r.colour.name));
      row.append(c);
    }
    preview.append(row);
    preview.append(el('div', 'tiny', lures.verdict(cond, top[0])));
  }
  paintAdvicePreview();

  /* ---- Espèces visées ---------------------------------------------------- */
  body.append(el('div', 'fm-step', '2 · Ce que tu cherches'));
  body.append(el('p', 'tiny', 'Trois au maximum. Le classement est celui de l’heure : marée, courant, lumière, saison, fond sous le bateau.'));

  const chosen = el('div', 'fm-chosen');
  body.append(chosen);

  const grid = el('div', 'fm-grid');
  const ranked = live.ranking({ limit: 62 });
  const cells = new Map();
  for (const r of ranked) {
    const c = el('button', 'fm-cell');
    c.type = 'button';
    c.append(el('span', 'fm-cell-ico', r.emoji || r.sp?.emoji || '🐟'));
    c.append(el('span', 'fm-cell-name', r.name));
    const badge = el('span', 'fm-cell-score', String(r.score));
    badge.style.background = heat(r.score);
    c.append(badge);
    if (r.noKill) c.append(el('span', 'fm-cell-flag', '↩'));
    c.addEventListener('click', () => toggleTarget(r));
    grid.append(c);
    cells.set(r.id, c);
  }
  body.append(grid);

  function toggleTarget(r) {
    const i = pick.targets.findIndex((x) => x.id === r.id);
    if (i >= 0) pick.targets.splice(i, 1);
    else if (pick.targets.length >= 3) return void toast('Trois espèces au maximum', 'warn');
    else pick.targets.push(r);
    navigator.vibrate?.(8);
    paintTargets();
  }
  function paintTargets() {
    for (const [id, c] of cells) c.classList.toggle('on', pick.targets.some((x) => x.id === id));
    clear(chosen);
    if (!pick.targets.length) {
      chosen.append(el('div', 'tiny', 'Aucune espèce visée — les conseils porteront sur les mieux classées du moment.'));
    } else {
      for (const t of pick.targets) {
        const chip = el('button', 'fm-chip');
        chip.type = 'button';
        chip.append(el('span', null, `${t.emoji || '🐟'} ${t.name}`), el('span', 'fm-chip-x', '✕'));
        chip.addEventListener('click', () => toggleTarget(t));
        chosen.append(chip);
      }
    }
    go.textContent = pick.targets.length
      ? `🎣 LANCER — ${pick.targets.map((t) => t.name).join(', ')}`
      : '🎣 LANCER LA PÊCHE';
  }

  const go = button('🎣 LANCER LA PÊCHE', 'btn-primary btn-lg fm-go', () => {
    session = { targets: pick.targets.slice(), skyId: pick.skyId, waterId: pick.waterId };
    closeSheet();
    emit('goto', 'fish-mode');
  });
  paintTargets();
  body.append(go);

  return openSheet('Mode pêche', body);
}

function swatch(emoji, name, colour, onClick) {
  const b = el('button', 'fm-swatch');
  b.type = 'button';
  const dot = el('span', 'fm-swatch-dot', emoji);
  dot.style.background = colour;
  b.append(dot, el('span', 'fm-swatch-name', name));
  b.addEventListener('click', onClick);
  return b;
}

/* Vert au-dessus de 60, ambre au-dessus de 35, gris en dessous. La couleur
 * dit l'ordre de grandeur ; le chiffre reste écrit à côté, parce qu'une
 * couleur seule ne se compare pas. */
function heat(score) {
  if (score >= 60) return 'rgba(163,230,53,.22)';
  if (score >= 35) return 'rgba(251,191,36,.22)';
  return 'rgba(148,163,184,.16)';
}

const driftKn = () => {
  const st = stream.tidalStream(Date.now(), state.fix || spots.getPort());
  return Number.isFinite(st?.spd) ? st.spd : 1;
};

async function ensurePrefs() {
  if (Object.keys(prefs).length) return;
  const saved = (await idb.get('kv', KEY_PREFS)) || {};
  for (const p of PANELS) prefs[p.id] = saved[p.id] ?? p.on;
}

/* ==========================================================================
 * Cycle de vie
 * ========================================================================== */
export async function mount(container) {
  root = clear(container);
  refs = {};
  layers = {};
  started = Date.now();
  caught = 0;

  await ensurePrefs();
  document.body.classList.add('angling');

  build();

  try {
    L = await loadLeaflet();
    buildMap();
  } catch {
    refs.mapHost.append(el('div', 'fm-nomap', 'Carte indisponible hors cache. Le reste du mode fonctionne : touches, prises et conseils sont enregistrés.'));
  }

  traces.begin(started);
  unsubs.push(subscribe('fix', onFix));
  unsubs.push(on('catches:changed', () => { caught++; drawPings(); }));
  unsubs.push(on('traces:changed', drawTraces));
  timer = setInterval(paintPanel, 5000);
  onFix();
  paintPanel();
  paintAdvice();
}

export function unmount() {
  unsubs.forEach((fn) => fn?.());
  unsubs = [];
  clearInterval(timer);
  traces.end();
  map?.remove();
  map = null;
  layers = {};
  refs = {};
  document.body.classList.remove('angling');
}

export function refresh() {
  map?.invalidateSize();
  paintPanel();
}

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.append(link);
    const s = document.createElement('script');
    s.src = LEAFLET_JS;
    s.async = true;
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error('Leaflet indisponible'));
    document.head.append(s);
  });
}

/* ==========================================================================
 * Habillage
 * ========================================================================== */
function build() {
  const box = clear(root);
  box.classList.add('fm');

  /* ---- Bandeau ----------------------------------------------------------- */
  const head = el('div', 'fm-head');
  const who = el('div', 'fm-who');
  /* UNE espèce écrite, et le compte des autres. Trois noms bout à bout font
   * quarante caractères, trois pictogrammes plus un nom en font encore trop :
   * sur 320 px, le bandeau ne dispose que de 188 px à côté de QUITTER, et la
   * ligne se coupait. Les deux autres espèces ne disparaissent pas pour
   * autant — elles ont chacune leur carte de conseils juste en dessous. */
  refs.title = el('div', 'fm-title', session.targets.length
    ? `${session.targets[0].emoji || '🐟'} ${session.targets[0].name}`
      + (session.targets.length > 1 ? ` +${session.targets.length - 1}` : '')
    : '🎣 PÊCHE');
  refs.sub = el('div', 'fm-headsub', '');
  who.append(refs.title, refs.sub);
  const out = el('button', 'fm-exit', '');
  out.type = 'button';
  out.append(el('span', null, '⤺'), el('span', null, 'QUITTER'));
  out.setAttribute('aria-label', 'Quitter le mode pêche');
  out.addEventListener('click', () => {
    navigator.vibrate?.(12);
    emit('goto', 'fish');
  });
  head.append(who, out);
  box.append(head);

  /* ---- Carte -------------------------------------------------------------
   * Elle occupe le haut et on ne pose RIEN dessus, sauf le bouton de réglages
   * dans un coin. La trace de dérive est l'objet du mode : un bouton posé
   * par-dessus la masque exactement là où elle devient intéressante. */
  refs.mapHost = el('div', 'fm-map');
  refs.mapHost.id = 'fm-leaflet';
  const gear = el('button', 'fm-gear', '⚙');
  gear.type = 'button';
  gear.title = 'Réglages du mode pêche';
  gear.setAttribute('aria-label', 'Réglages du mode pêche');
  gear.addEventListener('click', openFishSettings);
  const wrap = el('div', 'fm-mapwrap');
  wrap.append(refs.mapHost, gear);
  box.append(wrap);

  /* ---- Les deux gestes ---------------------------------------------------
   * Sous la carte, pleine largeur, 64 px de haut. Ce sont les deux seuls
   * boutons qu'on presse en pêchant, souvent une canne dans l'autre main. */
  const acts = el('div', 'fm-acts');
  refs.btnTouch = el('button', 'fm-act fm-touch', '');
  refs.btnTouch.type = 'button';
  refs.btnTouch.append(el('span', 'fm-act-ico', '🎣'),
    el('span', 'fm-act-txt', 'TOUCHE ICI'));
  refs.btnTouch.addEventListener('click', markTouch);

  refs.btnFish = el('button', 'fm-act fm-fish', '');
  refs.btnFish.type = 'button';
  refs.btnFish.append(el('span', 'fm-act-ico', '🐟'),
    el('span', 'fm-act-txt', 'À BORD'));
  refs.btnFish.addEventListener('click', openCatchPicker);

  acts.append(refs.btnTouch, refs.btnFish);
  box.append(acts);

  /* ---- Compteurs ---------------------------------------------------------- */
  refs.panel = el('div', 'fm-panel');
  box.append(refs.panel);

  /* ---- Conseils ----------------------------------------------------------- */
  refs.advice = el('div', 'fm-advice');
  box.append(refs.advice);
}

/* ==========================================================================
 * Carte
 * ========================================================================== */
function buildMap() {
  const start = state.fix || spots.getPort();
  map = L.map(refs.mapHost, {
    center: [start.lat, start.lon],
    zoom: 15,
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap',
  }).addTo(map);
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenSeaMap',
  }).addTo(map);

  layers.old = L.layerGroup().addTo(map);
  layers.live = L.polyline([], { color: '#fbbf24', weight: 4, opacity: 0.95 }).addTo(map);
  layers.pings = L.layerGroup().addTo(map);
  layers.boat = L.layerGroup().addTo(map);
  window.__fmMap = map;

  drawTraces();
  drawPings();
  setTimeout(() => map.invalidateSize(), 60);
}

/**
 * Les dérives passées, en cyan pâle et fines ; celle du jour, en ambre et
 * épaisse. On distingue d'un coup d'œil « ce que j'ai déjà fait » de « ce que
 * je fais maintenant », sans légende.
 */
function drawTraces() {
  if (!map || !layers.old) return;
  layers.old.clearLayers();
  const cur = traces.current();
  for (const tr of traces.all()) {
    if (tr === cur || tr.points.length < 2) continue;
    L.polyline(tr.points.map((p) => [p.lat, p.lon]), {
      color: '#22d3ee', weight: 2, opacity: 0.4, interactive: false,
    }).addTo(layers.old);
  }
  if (cur) layers.live.setLatLngs(cur.points.map((p) => [p.lat, p.lon]));
}

function drawPings() {
  if (!map || !layers.pings) return;
  layers.pings.clearLayers();
  for (const p of traces.allPings()) {
    L.circleMarker([p.lat, p.lon], {
      radius: 7, color: '#fbbf24', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.5,
    }).addTo(layers.pings).bindTooltip(
      `${p.kind === 'prise' ? '🐟' : '🎣'} ${fmt.hhmm(p.t)}${p.note ? ` · ${p.note}` : ''}`,
      { className: 'spot-label', direction: 'top' },
    );
  }
}

function onFix() {
  const fix = state.fix;
  if (!fix) return;
  const moved = traces.push(fix);
  if (map) {
    if (moved) drawTraces();
    layers.boat.clearLayers();
    L.circleMarker([fix.lat, fix.lon], {
      radius: 6, color: '#0a1421', weight: 2, fillColor: '#22d3ee', fillOpacity: 1,
    }).addTo(layers.boat);
    /* La carte ne se recentre QUE si le bateau sort du cadre. Recentrer à
     * chaque point interdisait de faire glisser la carte pour aller regarder
     * une dérive de la semaine dernière : le doigt écartait, le fix suivant
     * ramenait. Or c'est exactement pour ça qu'on garde les traces. Ici, on
     * peut regarder où l'on veut, et le bateau se rattrape tout seul quand il
     * s'échappe. */
    if (!map.getBounds().pad(-0.18).contains([fix.lat, fix.lon])) {
      map.panTo([fix.lat, fix.lon], { animate: true, duration: 0.5 });
    }
  }
  paintPanel();
}

/* ==========================================================================
 * Les deux gestes
 * ========================================================================== */

/** « Ça a touché ici. » Un doigt, une vibration, un point sur la carte. */
function markTouch() {
  const fix = state.fix;
  if (!fix) return void toast('Pas de position GPS — la touche ne peut pas être située', 'warn');
  traces.ping({ lat: fix.lat, lon: fix.lon, kind: 'touche' });
  navigator.vibrate?.([15, 30, 15]);
  drawPings();
  paintPanel();
  toast('🎣 Touche marquée', 'good', 2600, { label: 'Annuler', onClick: () => {
    traces.undoPing();
    drawPings();
    paintPanel();
  } });
}

/**
 * Le poisson est à bord. On propose D'ABORD les espèces visées — c'est ce
 * qu'on vient de sortir neuf fois sur dix — puis les mieux classées du
 * moment, puis le catalogue entier. Trois touches maximum dans le pire cas,
 * une seule dans le cas courant.
 */
function openCatchPicker() {
  const body = el('div');
  const shortcut = [...session.targets];
  const ranked = live.ranking({ limit: 12 }).filter((r) => !shortcut.some((s) => s.id === r.id));

  const mkRow = (list, title) => {
    if (!list.length) return;
    body.append(el('div', 'fm-sub', title));
    const g = el('div', 'fm-grid');
    for (const r of list) {
      const c = el('button', 'fm-cell');
      c.type = 'button';
      c.append(el('span', 'fm-cell-ico', r.emoji || '🐟'));
      c.append(el('span', 'fm-cell-name', r.name));
      if (r.score != null) {
        const b = el('span', 'fm-cell-score', String(r.score));
        b.style.background = heat(r.score);
        c.append(b);
      }
      c.addEventListener('click', async () => {
        closeSheet();
        await record.record(r.id);
        const fix = state.fix;
        if (fix) traces.ping({ lat: fix.lat, lon: fix.lon, kind: 'prise', note: r.name });
        drawPings();
        paintPanel();
      });
      g.append(c);
    }
    body.append(g);
  };

  mkRow(shortcut, 'Tes espèces visées');
  mkRow(ranked, 'Les mieux classées maintenant');

  body.append(button('📋 Tout le catalogue · fiche détaillée', 'btn-lg', () => {
    closeSheet();
    record.openDetailForm();
  }));

  openSheet('Poisson à bord', body);
}

/* ==========================================================================
 * Compteurs
 * ========================================================================== */
function paintPanel() {
  if (!refs.panel) return;
  const now = Date.now();
  const fix = state.fix;
  const pos = fix || spots.getPort();
  const st = stream.tidalStream(now, pos);
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const box = clear(refs.panel);

  const cell = (val, lbl, cls = '') => {
    const c = el('div', 'fm-count');
    c.append(el('div', `fm-count-v tnum ${cls}`, val), el('div', 'fm-count-l', lbl));
    box.append(c);
  };

  if (prefs.derive) {
    const d = stream.driftVector(now, pos, wx);
    cell(`${fmt.num(d.spd, 1)} nd`, `DÉRIVE ${fmt.cardinal(d.dir)}`, 'c-cyan');
  }
  if (prefs.trace) {
    cell(fmt.dist(traces.liveLengthM()), 'DÉRIVE EN COURS');
  }
  if (prefs.courant) {
    cell(`${fmt.num(st.spd, 1)} nd`, `COURANT ${fmt.cardinal(st.dir)}`);
    if (st.slackT) cell(fmt.hhmm(st.slackT), 'ÉTALE', 'c-amber');
  }
  if (prefs.maree) {
    cell(`${fmt.num(tide.height(now), 1)} m`, tide.rate(now) >= 0 ? 'MARÉE MONTE' : 'MARÉE DESCEND');
    cell(String(tide.coefficient(now)), 'COEFFICIENT');
  }
  if (prefs.fond) {
    const cls = seabed.ready() ? seabed.at(pos.lat, pos.lon) : null;
    cell(cls?.fr ? cls.fr.split(' ')[0] : '—', 'FOND');
  }
  if (prefs.vent && wx) {
    cell(`${Math.round(wx.windSpeedKn)} nd`, fmt.windFrom(wx.windDirDeg).toUpperCase());
  }
  if (prefs.eau && wx?.seaTempC != null) cell(`${fmt.num(wx.seaTempC, 1)}°`, 'EAU');
  if (prefs.prises) cell(String(caught), 'PRISES', caught ? 'c-lime' : '');
  if (prefs.heure) cell(fmt.duration(now - started), 'EN PÊCHE');

  const n = traces.allPings().length;
  refs.sub.textContent = `${n} touche${n > 1 ? 's' : ''} marquée${n > 1 ? 's' : ''}${caught ? ` · ${caught} à bord` : ''}`;
}

/* ==========================================================================
 * Conseils
 * --------------------------------------------------------------------------
 * Pour chaque espèce visée : où chercher, à quelle profondeur, avec quoi. Ce
 * sont les trois questions d'un débutant, et ce sont aussi les trois lignes
 * qu'un habitué relit quand il change de poste.
 * ========================================================================== */
function paintAdvice() {
  const box = clear(refs.advice);
  const now = Date.now();
  const pos = state.fix || spots.getPort();
  const kn = driftKn();

  /* ---- Couleur du leurre, si le ciel et l'eau ont été donnés ------------- */
  if (session.skyId && session.waterId) {
    const cond = lures.conditions({ skyId: session.skyId, waterId: session.waterId, depthM: 12, currentKn: kn });
    const top = lures.rank(cond, { limit: 3 });
    const card = el('div', 'fm-card');
    card.append(el('div', 'fm-card-h', '🎨 Couleur conseillée'));
    const row = el('div', 'fm-lures');
    for (const r of top) {
      const c = el('div', 'fm-lure');
      const dot = el('span', 'fm-lure-dot');
      dot.style.background = r.colour.hex;
      c.append(dot, el('span', null, r.colour.name));
      row.append(c);
    }
    card.append(row);
    card.append(el('div', 'fm-line', lures.verdict(cond, top[0])));
    // rigWeight() rend un objet — { grams, alt, raw } — et pas un nombre. Collé
    // tel quel dans un gabarit, il écrivait « [object Object] g ». La sortie
    // d'une fonction se lit dans la fonction, jamais dans son nom.
    const w = lures.rigWeight(12, kn);
    const fam = lures.family(cond);
    card.append(el('div', 'fm-line',
      `Plombée : ${w.grams} g par 12 m de fond à ${fmt.num(kn, 1)} nd de courant — ${w.alt} g si ça ne touche pas le fond.`));
    if (fam) card.append(line(fam.name, fam.why));
    box.append(card);
  } else {
    const card = el('div', 'fm-card');
    card.append(el('div', 'fm-card-h', '🎨 Couleur du leurre'));
    card.append(el('div', 'fm-line', 'Ciel et eau non renseignés au lancement. Touche ⚙ pour les donner : c’est ce qui transforme un conseil général en conseil du jour.'));
    box.append(card);
  }

  /* ---- Une carte par espèce visée ---------------------------------------- */
  const list = session.targets.length ? session.targets : live.ranking({ limit: 2 });
  for (const t of list) {
    const sp = t.sp || catalog.findSpecies(t.id);
    if (!sp) continue;
    const card = el('div', 'fm-card');
    const h = el('div', 'fm-card-h', `${sp.emoji || '🐟'} ${sp.name}`);
    if (t.score != null) {
      const b = el('span', 'fm-cell-score', String(t.score));
      b.style.background = heat(t.score);
      h.append(b);
    }
    card.append(h);
    if (sp.technique) card.append(line('Montage', sp.technique));
    if (sp.habitat?.length) card.append(line('Où chercher', sp.habitat.map(habitatLabel).join(', ')));
    if (sp.depthM) card.append(line('Profondeur', `${sp.depthM[0]}–${sp.depthM[1]} m`));
    if (sp.minSizeCm) card.append(line('Maille', `${sp.minSizeCm} cm${sp.bag ? ` · ${sp.bag} par jour` : ''}`));
    if (t.noKill) card.append(el('div', 'fm-warn', '↩ Capture-relâcher : remise à l’eau obligatoire.'));
    if (sp.note) card.append(el('div', 'fm-line fm-dim', sp.note));
    box.append(card);
  }

  /* ---- Ce que la marée dit, maintenant ----------------------------------- */
  const st = stream.tidalStream(now, pos);
  const card = el('div', 'fm-card');
  card.append(el('div', 'fm-card-h', '🌊 Le moment'));
  card.append(el('div', 'fm-line',
    st.sense === 'slack'
      ? `Étale. Les poissons de fond décrochent, c’est le moment des postes précis et des montages légers.`
      : `Courant ${fmt.num(st.spd, 1)} nd portant au ${fmt.heading(st.dir)}. Étale à ${fmt.hhmm(st.slackT)}. La dérive travaille pour toi : présente le leurre en amont du poste.`));
  box.append(card);
}

function line(k, v) {
  const r = el('div', 'fm-line');
  r.append(el('span', 'fm-line-k', `${k} · `), el('span', null, v));
  return r;
}

const HABITATS = {
  epave: 'épaves', ridin: 'ridins de sable', roche: 'roche', veine: 'veines de courant',
  sable: 'sable', chenal: 'chenaux', tombant: 'tombants', vase: 'vase',
  gravier: 'gravier', port: 'port et digues', surface: 'surface', pleine: 'pleine eau',
};
const habitatLabel = (h) => HABITATS[h] || h;

/* ==========================================================================
 * Réglages
 * ========================================================================== */
function openFishSettings() {
  const body = el('div');

  /* ---- Ciel et eau, rattrapables en cours de sortie ---------------------- */
  body.append(el('div', 'fm-sub', 'Ce que tu vois'));
  body.append(el('p', 'tiny', 'La lumière change dans la journée, l’eau se charge après un coup de vent. On peut les corriger sans quitter le mode.'));
  const skyRow = el('div', 'fm-swatches');
  for (const s of lures.SKIES) {
    const b = swatch(s.emoji, s.name, s.swatch, () => {
      session.skyId = session.skyId === s.id ? null : s.id;
      paint();
      paintAdvice();
    });
    b.dataset.id = s.id;
    skyRow.append(b);
  }
  const waterRow = el('div', 'fm-swatches');
  for (const w of lures.WATERS) {
    const b = swatch(w.emoji || '💧', w.name, w.swatch, () => {
      session.waterId = session.waterId === w.id ? null : w.id;
      paint();
      paintAdvice();
    });
    b.dataset.id = w.id;
    waterRow.append(b);
  }
  body.append(skyRow, waterRow);
  const paint = () => {
    for (const b of skyRow.children) b.classList.toggle('on', b.dataset.id === session.skyId);
    for (const b of waterRow.children) b.classList.toggle('on', b.dataset.id === session.waterId);
  };
  paint();

  /* ---- Ce que le panneau affiche ----------------------------------------- */
  body.append(el('div', 'fm-sub', 'Le panneau de contrôle'));
  body.append(el('p', 'tiny', 'Allume ce que tu regardes, éteins le reste. Le choix est gardé d’une sortie à l’autre.'));
  for (const p of PANELS) {
    const row = el('button', 'fm-toggle');
    row.type = 'button';
    const txt = el('div');
    txt.append(el('div', 'fm-toggle-n', p.name));
    if (p.hint) txt.append(el('div', 'fm-toggle-h', p.hint));
    const box2 = el('span', 'fm-toggle-box', '✓');
    row.append(txt, box2);
    const sync = () => {
      row.classList.toggle('on', !!prefs[p.id]);
      row.setAttribute('aria-pressed', prefs[p.id] ? 'true' : 'false');
    };
    row.addEventListener('click', async () => {
      prefs[p.id] = !prefs[p.id];
      sync();
      paintPanel();
      await idb.put('kv', KEY_PREFS, { ...prefs });
    });
    sync();
    body.append(row);
  }

  /* ---- Les traces --------------------------------------------------------- */
  const s = traces.stats();
  body.append(el('div', 'fm-sub', 'Les traces'));
  body.append(el('p', 'tiny',
    `${s.traces} dérive${s.traces > 1 ? 's' : ''} en mémoire, ${s.pings} touche${s.pings > 1 ? 's' : ''}. Elles restent sur ce téléphone et ne partent nulle part.`));
  body.append(button('🧹 Effacer toutes les traces de dérive', 'btn-danger', async () => {
    await traces.clearTraces();
    traces.begin();
    drawTraces();
    toast('Traces effacées', 'good');
    closeSheet();
  }));
  body.append(button('🧹 Effacer toutes les touches', 'btn-danger', async () => {
    await traces.clearPings();
    drawPings();
    paintPanel();
    toast('Touches effacées', 'good');
    closeSheet();
  }));

  openSheet('Réglages du mode pêche', body);
}

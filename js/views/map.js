/* ==========================================================================
 * views/map.js — mode CARTE et dérive prédictive
 * --------------------------------------------------------------------------
 * Trois choses qu'une carte de pêche doit faire, et que les apps de rando ne
 * font pas :
 *
 * 1. MARQUES MARITIMES. Surcouche OpenSeaMap (libre, sans clé) : bouées,
 *    cardinales, feux, zones. Sur un fond OSM seul, on ne voit pas les dangers.
 *
 * 2. TUILES HORS LIGNE. Bouton de préchargement de la zone dans IndexedDB.
 *    Une carte qui devient grise à 6 milles du bord n'est pas une carte.
 *
 * 3. DÉRIVE PRÉDICTIVE, dans les deux sens :
 *      • en avant  : « si je coupe le moteur ici, je passe là dans 40 min »
 *      • à rebours : « je veux dériver SUR ce point à 07 h 30, où je largue ? »
 *    Le second est le vrai geste de pêche, et personne ne le propose.
 *    Le tracé est encadré d'un cône d'incertitude : un modèle de courant
 *    affiché comme un trait fin est un mensonge graphique.
 * ========================================================================== */

import { state, subscribe, set, on, emit } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from '../ui/dom.js';
import * as fmt from '../core/fmt.js';
import { distance, bearing, destination as project, toGPX } from '../core/geo.js';
import * as route from '../nav/route.js';
import { openDestinationPicker, startNav } from '../ui/destination.js';
import * as stream from '../data/stream.js';
import * as weather from '../data/weather.js';
import * as spots from '../fishing/spots.js';
import * as tide from '../data/tide.js';
import * as gps from '../sensors/gps.js';
import * as idb from '../core/idb.js';
import * as learning from '../fishing/learning.js';
import * as seabed from '../data/seabed.js';
import * as record from '../fishing/record.js';

// Leaflet est EMBARQUÉ, pas en CDN. Le CDN condamnait ce mode au premier
// lancement hors ligne : tant que le moteur n'avait pas été téléchargé une
// fois, l'écran affichait « carte indisponible ». Pour une app dont la règle
// est « le réseau est une option, jamais une dépendance », c'était le seul
// écran qui trahissait le principe. 42 ko gzippés, et la carte s'ouvre dès la
// première fois, en mode avion.
const LEAFLET_CSS = 'vendor/leaflet/leaflet.css';
const LEAFLET_JS = 'vendor/leaflet/leaflet.js';

let L = null;
let map = null;
let root;
let unsub;
let unsubHeading;
let timer = 0;
let layers = {};
let boatMarker = null;
let refs = {};
let ui = {
  follow: true,
  seamarks: true,
  vectors: false,
  catches: true,
  driftMin: 40,
  target: null,   // cible de dérive inverse
  mode: 'forward',
};

/* ==========================================================================
 * Chargement de Leaflet
 * --------------------------------------------------------------------------
 * Fichier local, précaché par le service worker avec le reste de la coque.
 * L'échec ne devrait plus survenir ; le repli reste en place au cas où le
 * cache serait purgé pendant que l'appareil est hors ligne.
 * ========================================================================== */
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
 * Couche de tuiles avec cache IndexedDB
 * ========================================================================== */
function makeCachedLayer(Lref, url, opts, layerKey) {
  const Cached = Lref.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.alt = '';
      const key = `${layerKey}/${coords.z}/${coords.x}/${coords.y}`;
      const src = Lref.Util.template(url, { ...coords, s: 'a', r: '' });

      idb.get('tiles', key).then((blob) => {
        if (blob) {
          img.src = URL.createObjectURL(blob);
          img.onload = () => {
            URL.revokeObjectURL(img.src);
            done(null, img);
          };
          return;
        }
        img.crossOrigin = 'anonymous';
        img.src = src;
        img.onload = () => {
          done(null, img);
          // Mise en cache opportuniste : ce qu'on a regardé une fois au port
          // est disponible au large. Silencieux, et sans bloquer le rendu.
          if (navigator.onLine) {
            fetch(src, { mode: 'cors' })
              .then((r) => (r.ok ? r.blob() : null))
              .then((b) => b && idb.put('tiles', key, b))
              .catch(() => {});
          }
        };
        img.onerror = () => done(new Error('tile'), img);
      });
      return img;
    },
  });
  return new Cached(url, opts);
}

/* ==========================================================================
 * Montage
 * ========================================================================== */
export async function mount(container) {
  root = clear(container);

  const holder = el('div');
  holder.id = 'leaflet';
  root.append(holder);

  try {
    L = await loadLeaflet();
  } catch {
    root.append(offlineNotice());
    return;
  }

  const start = state.fix || spots.getPort();
  map = L.map(holder, {
    center: [start.lat, start.lon],
    zoom: 12,
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  layers.base = makeCachedLayer(
    L,
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 18, attribution: '© OpenStreetMap' },
    'osm',
  ).addTo(map);

  layers.sea = makeCachedLayer(
    L,
    'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    { maxZoom: 18, opacity: 1, attribution: '© OpenSeaMap' },
    'seamark',
  ).addTo(map);

  layers.track = L.polyline([], { color: '#22d3ee', weight: 2.5, opacity: 0.75 }).addTo(map);
  layers.route = L.layerGroup().addTo(map);
  layers.drift = L.layerGroup().addTo(map);
  layers.vectors = L.layerGroup();
  layers.spots = L.layerGroup().addTo(map);
  layers.catches = L.layerGroup().addTo(map);
  layers.boat = L.layerGroup().addTo(map);

  // Référence de débogage : permet d'inspecter les couches depuis la console
  // ou un test de bout en bout. Aucun code applicatif ne l'utilise.
  window.__map = map;

  buildOverlay();
  drawSpots();
  drawCatches();

  map.on('movestart', () => {
    if (ui.follow && !map._programmaticMove) setFollow(false);
  });
  // Appui long. `contextmenu` suffit sur desktop et Android, mais Safari iOS
  // ne le déclenche pas de façon fiable au toucher : on double avec un vrai
  // détecteur d'appui long, annulé au moindre déplacement (sinon un début de
  // panoramique ouvrirait la feuille).
  map.on('contextmenu', (e) => onLongPress(e.latlng));
  let pressTimer = 0;
  let pressStart = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
  holder.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return cancelPress();
    const t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY };
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      navigator.vibrate?.(12);
      onLongPress(map.containerPointToLatLng(
        L.point(t.clientX - holder.getBoundingClientRect().left,
                t.clientY - holder.getBoundingClientRect().top),
      ));
    }, 550);
  }, { passive: true });
  holder.addEventListener('touchmove', (e) => {
    if (!pressStart || !pressTimer) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 12) cancelPress();
  }, { passive: true });
  holder.addEventListener('touchend', cancelPress, { passive: true });
  holder.addEventListener('touchcancel', cancelPress, { passive: true });
  map.on('click', (e) => {
    if (ui.mode === 'reverse') {
      ui.target = { lat: e.latlng.lat, lon: e.latlng.lng };
      drawDrift();
    }
  });

  unsub = subscribe(['fix', 'weather', 'waypoint', 'mob', 'anchor', 'nav'], onState);
  // Le cap a son propre abonnement : redessiner tout le calque bateau à la
  // cadence du magnétomètre serait absurde, alors qu'une rotation de l'icône
  // suffit — et sans elle, l'étrave reste figée quand on pivote au mouillage.
  unsubHeading = subscribe('heading', rotateBoat);
  timer = setInterval(() => {
    drawDrift();
    if (ui.vectors) drawVectors();
  }, 20000);

  onState();
  setTimeout(() => map.invalidateSize(), 60);
}

export function unmount() {
  unsub?.();
  unsubHeading?.();
  boatMarker = null;
  clearInterval(timer);
  map?.remove();
  map = null;
  layers = {};
  refs = {};
}

export function refresh() {
  map?.invalidateSize();
}

function offlineNotice() {
  const box = el('div', 'card');
  box.style.margin = '16px';
  box.append(el('h3', 'list-title', 'Carte indisponible hors ligne'));
  box.append(el('p', 'muted', "Le moteur de carte n'a pas pu être chargé depuis le cache de l'application. Recharge la page ; si le problème persiste, réinstalle l'app depuis l'écran d'accueil."));
  box.append(button('Réessayer', 'btn-primary', () => mount(root)));
  return box;
}

/* ==========================================================================
 * Habillage
 * ========================================================================== */
function buildOverlay() {
  /* --- Bandeau supérieur --- */
  const top = el('div', 'map-overlay map-top');
  refs.readout = el('div', 'map-panel');
  refs.readout.style.flex = '1';
  refs.readout.style.fontSize = '12px';
  top.append(refs.readout);
  root.append(top);

  /* --- Colonne de boutons --- */
  const right = el('div', 'map-overlay map-right');
  refs.btnNav = mapBtn('🎯', navButton, 'Naviguer vers…');
  refs.btnFollow = mapBtn('◎', () => setFollow(!ui.follow), 'Recentrer / suivre');
  refs.btnSea = mapBtn('⚓', () => {
    ui.seamarks = !ui.seamarks;
    ui.seamarks ? layers.sea.addTo(map) : map.removeLayer(layers.sea);
    refs.btnSea.classList.toggle('on', ui.seamarks);
  }, 'Balisage maritime');
  refs.btnVec = mapBtn('↗', () => {
    ui.vectors = !ui.vectors;
    if (ui.vectors) {
      layers.vectors.addTo(map);
      drawVectors();
    } else map.removeLayer(layers.vectors);
    refs.btnVec.classList.toggle('on', ui.vectors);
  }, 'Champ de courant');
  refs.btnCatch = mapBtn('🐟', () => {
    ui.catches = !ui.catches;
    if (ui.catches) {
      layers.catches.addTo(map);
      drawCatches();
    } else map.removeLayer(layers.catches);
    refs.btnCatch.classList.toggle('on', ui.catches);
  }, 'Mes prises');
  refs.btnMark = mapBtn('📍', markHere, 'Marquer la position');
  refs.btnDl = mapBtn('⤓', downloadZone, 'Précharger la zone');
  refs.btnDrift = mapBtn('⏱', recordDrift, 'Relever une dérive');
  refs.btnGpx = mapBtn('📤', exportGPX, 'Exporter en GPX');
  right.append(refs.btnNav, refs.btnFollow, refs.btnSea, refs.btnVec, refs.btnCatch,
               refs.btnMark, refs.btnDrift, refs.btnDl, refs.btnGpx);
  refs.btnNav.classList.toggle('on', !!state.nav);
  refs.btnSea.classList.add('on');
  refs.btnCatch.classList.add('on');
  refs.btnFollow.classList.add('on');
  root.append(right);

  /* --- Panneau de dérive --- */
  const bottom = el('div', 'map-overlay map-bottom');
  const panel = el('div', 'map-panel');

  const seg = el('div', 'seg');
  const bFwd = el('button', 'on', 'Dérive prévue');
  const bRev = el('button', '', 'Point de largage');
  bFwd.type = bRev.type = 'button';
  bFwd.addEventListener('click', () => setMode('forward', bFwd, bRev));
  bRev.addEventListener('click', () => setMode('reverse', bFwd, bRev));
  seg.append(bFwd, bRev);
  panel.append(seg);

  const row = el('div', 'row');
  row.style.marginTop = '8px';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '10';
  slider.max = '120';
  slider.step = '5';
  slider.value = String(ui.driftMin);
  slider.style.flex = '1';
  slider.addEventListener('input', () => {
    ui.driftMin = Number(slider.value);
    refs.durLbl.textContent = `${ui.driftMin} min`;
    drawDrift();
  });
  refs.durLbl = el('span', 'tnum', `${ui.driftMin} min`);
  refs.durLbl.style.width = '58px';
  refs.durLbl.style.textAlign = 'right';
  refs.durLbl.style.fontSize = '13px';
  refs.durLbl.style.fontWeight = '700';
  row.append(el('span', 'tiny', 'Durée'), slider, refs.durLbl);
  panel.append(row);

  // Le panneau est volontairement bas : il flotte AU-DESSUS de la carte, et
  // c'est la carte qu'on est venu voir. Le relevé tient en deux lignes, les
  // actions sont montées dans la colonne d'icônes, et l'avertissement de
  // calibration devient une pastille au lieu de deux lignes de texte.
  refs.driftInfo = el('div', 'tiny map-readout');
  refs.driftInfo.style.whiteSpace = 'pre-line';
  panel.append(refs.driftInfo);

  refs.driftWarn = el('span', 'chip warn');
  refs.driftWarn.style.marginTop = '5px';
  panel.append(refs.driftWarn);

  bottom.append(panel);
  root.append(bottom);
}

function mapBtn(glyph, onClick, title) {
  const b = el('button', 'map-btn', glyph);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function setMode(mode, bFwd, bRev) {
  ui.mode = mode;
  bFwd.classList.toggle('on', mode === 'forward');
  bRev.classList.toggle('on', mode === 'reverse');
  if (mode === 'reverse' && !ui.target) {
    toast('Touche la carte sur le point à survoler');
  }
  drawDrift();
}

function setFollow(v) {
  ui.follow = v;
  refs.btnFollow?.classList.toggle('on', v);
  if (v && state.fix) {
    map._programmaticMove = true;
    map.panTo([state.fix.lat, state.fix.lon], { animate: true });
    setTimeout(() => (map._programmaticMove = false), 400);
  }
}

/* ==========================================================================
 * Rendu
 * ========================================================================== */
function onState() {
  if (!map) return;
  drawBoat();
  drawRoute();
  drawDrift();
  if (gps.track.length > 1) {
    layers.track.setLatLngs(gps.track.map((p) => [p.lat, p.lon]));
  }
}

/* ==========================================================================
 * Route active
 * --------------------------------------------------------------------------
 * Deux traits, et ils ne se superposent pas : en vert la route voulue, en
 * cyan le CAP À TENIR. L'écart entre les deux EST la correction de dérive —
 * c'est la seule représentation qui rende évident, d'un coup d'œil, pourquoi
 * l'app demande de viser à côté du but. Un chiffre de correction dans un coin
 * ne convainc personne ; deux traits qui divergent, si.
 * ========================================================================== */
function drawRoute() {
  const g = layers.route;
  if (!g) return;
  g.clearLayers();
  const nav = state.nav;
  if (!nav) return;

  const dest = [nav.lat, nav.lon];
  const sol = route.solve();

  if (nav.origin) {
    L.polyline([[nav.origin.lat, nav.origin.lon], dest], {
      color: '#a3e635', weight: 2, opacity: 0.55, dashArray: '8 6', interactive: false,
    }).addTo(g);
  }

  if (state.fix && sol?.ok) {
    // Route directe restante
    L.polyline([[state.fix.lat, state.fix.lon], dest], {
      color: '#a3e635', weight: 3, opacity: 0.9, interactive: false,
    }).addTo(g);

    // Cap à tenir, sur un mille : au-delà on encombre la carte pour rien.
    const end = project(state.fix, sol.ctsDeg, Math.min(1852, Math.max(300, sol.distanceM)));
    L.polyline([[state.fix.lat, state.fix.lon], [end.lat, end.lon]], {
      color: '#22d3ee', weight: 2.5, opacity: 0.95, dashArray: '2 6', interactive: false,
    }).addTo(g);
  }

  // Cercles d'approche et d'arrivée
  L.circle(dest, {
    radius: route.APPROACH_M, color: '#a3e635', weight: 1, opacity: 0.35,
    dashArray: '3 7', fillOpacity: 0.03, interactive: false,
  }).addTo(g);
  L.circle(dest, {
    radius: Math.max(nav.arrivalRadiusM, 8), color: '#a3e635', weight: 2,
    fillOpacity: 0.15, interactive: false,
  }).addTo(g);

  // Un point saisi au clavier porte ses coordonnées comme nom : les répéter à
  // côté du marqueur, sur la carte où il est déjà posé, n'apprend rien et cache
  // le fond.
  const posTxt = fmt.posDDM(nav);
  const label = (nav.name === posTxt ? '' : `${nav.name} `) + (sol?.ok ? fmt.dist(sol.distanceM) : '');
  L.marker(dest, {
    icon: L.divIcon({ className: '', html: '<div style="font-size:24px">🎯</div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
  }).addTo(g).bindTooltip(
    label.trim() || nav.name,
    { permanent: true, className: 'spot-label', direction: 'top', offset: [0, -12] },
  );
}

/** Rotation seule de l'étrave — quelques microsecondes, pas de redessin. */
function rotateBoat() {
  const svg = boatMarker?.getElement()?.firstElementChild;
  if (!svg) return;
  const hdg = state.heading?.deg ?? state.fix?.cogDeg ?? 0;
  svg.style.transform = `rotate(${hdg.toFixed(1)}deg)`;
}

function drawBoat() {
  const g = layers.boat;
  g.clearLayers();
  boatMarker = null;
  const fix = state.fix;
  if (!fix) return;

  if (fix.accuracy) {
    L.circle([fix.lat, fix.lon], {
      radius: fix.accuracy,
      color: '#22d3ee',
      weight: 1,
      opacity: 0.35,
      fillOpacity: 0.07,
    }).addTo(g);
  }

  const hdg = state.heading?.deg ?? fix.cogDeg ?? 0;
  const icon = L.divIcon({
    className: 'boat-marker',
    html: `<svg width="30" height="30" viewBox="0 0 30 30" style="transform:rotate(${hdg}deg)">
      <path d="M15 2 L22 26 L15 21 L8 26 Z" fill="#22d3ee" stroke="#050b14" stroke-width="1.6"/></svg>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  boatMarker = L.marker([fix.lat, fix.lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(g);

  if (ui.follow) {
    map._programmaticMove = true;
    map.panTo([fix.lat, fix.lon], { animate: true, duration: 0.4 });
    setTimeout(() => (map._programmaticMove = false), 500);
  }

  if (state.mob) {
    L.marker([state.mob.lat, state.mob.lon], {
      icon: L.divIcon({ className: '', html: '<div style="font-size:24px">🆘</div>', iconSize: [24, 24] }),
    }).addTo(g).bindTooltip('MOB', { permanent: true, className: 'spot-label' });
  }
  if (state.waypoint) {
    L.marker([state.waypoint.lat, state.waypoint.lon], {
      icon: L.divIcon({ className: '', html: '<div style="font-size:20px">🏁</div>', iconSize: [20, 20] }),
    }).addTo(g);
  }
  if (state.anchor?.armed) {
    L.circle([state.anchor.lat, state.anchor.lon], {
      radius: state.anchor.radiusM,
      color: '#a3e635',
      weight: 1.5,
      dashArray: '4 4',
      fillOpacity: 0.04,
    }).addTo(g);
  }
}

function drawSpots() {
  const g = layers.spots;
  g.clearLayers();
  for (const s of spots.all()) {
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: s.seed ? 7 : 6,
      color: s.seed ? '#a78bfa' : '#a3e635',
      weight: 2,
      dashArray: s.seed ? '3 3' : null,
      fillOpacity: s.seed ? 0.08 : 0.35,
    }).addTo(g);
    marker.bindTooltip(s.name, { className: 'spot-label', direction: 'top', offset: [0, -6] });
    marker.on('click', (e) => {
      L.DomEvent.stop(e);
      showSpot(s);
    });
    if (s.radiusM > 400) {
      L.circle([s.lat, s.lon], {
        radius: s.radiusM,
        color: s.seed ? '#a78bfa' : '#a3e635',
        weight: 1,
        opacity: 0.3,
        dashArray: '2 5',
        fillOpacity: 0.03,
        interactive: false,
      }).addTo(g);
    }
  }
}

function drawDrift() {
  if (!map) return;
  const g = layers.drift;
  g.clearLayers();
  const now = Date.now();
  const hourly = state.weather?.hourly || [];
  const origin = state.fix || spots.getPort();

  let track;
  let head = '';

  if (ui.mode === 'reverse') {
    if (!ui.target) {
      refs.driftInfo.textContent = 'Touche la carte sur le point à survoler, puis règle la durée de dérive.';
      updateReadout();
      return;
    }
    const arriveT = now + ui.driftMin * 60000;
    const res = stream.dropPoint(ui.target, arriveT, ui.driftMin, hourly);
    track = res.track;
    const d = distance(origin, res.drop);
    const b = bearing(origin, res.drop);
    // Deux lignes, pas trois : le relevé est plafonné en hauteur pour ne pas
    // manger la carte, et une phrase coupée au milieu ne sert à personne.
    head =
      `Largage ${fmt.hhmm(res.startT)} · ${fmt.dist(d)} au ${fmt.heading(b)}\n` +
      `${fmt.latDDM(res.drop.lat)} ${fmt.lonDDM(res.drop.lon)} · cible à ${fmt.hhmm(arriveT)}`;

    L.marker([res.drop.lat, res.drop.lon], {
      icon: L.divIcon({ className: '', html: '<div style="font-size:20px">⤵️</div>', iconSize: [20, 20] }),
    }).addTo(g).bindTooltip('Largage', { permanent: true, className: 'spot-label', direction: 'left' });

    L.circleMarker([ui.target.lat, ui.target.lon], {
      radius: 8, color: '#fbbf24', weight: 2, fillOpacity: 0.25,
    }).addTo(g).bindTooltip('Cible', { permanent: true, className: 'spot-label' });
  } else {
    track = stream.predictDrift(origin, now, ui.driftMin, hourly);
    const end = track.points.at(-1);
    head =
      `Dérive ${fmt.num(track.meanVec.spd, 1)} nd au ${fmt.heading(track.meanVec.dir)} (${fmt.cardinal(track.meanVec.dir)})\n` +
      `${fmt.dist(track.distanceM)} en ${ui.driftMin} min · ±${Math.round(track.spreadM)} m` +
      (end ? ` · arrivée ${fmt.hhmm(end.t)}` : '');
  }

  // Cône d'incertitude
  const cone = stream.uncertaintyCone(track);
  if (cone.length) {
    L.polygon(cone.map((p) => [p.lat, p.lon]), {
      color: '#22d3ee', weight: 0, fillColor: '#22d3ee', fillOpacity: 0.1, interactive: false,
    }).addTo(g);
  }

  L.polyline(track.points.map((p) => [p.lat, p.lon]), {
    color: '#fbbf24', weight: 3, opacity: 0.95, dashArray: '6 4',
  }).addTo(g);

  // Repères de temps toutes les 10 min
  const stepIdx = Math.max(1, Math.round(track.points.length / (ui.driftMin / 10)));
  track.points.forEach((p, i) => {
    if (i === 0 || i % stepIdx !== 0) return;
    L.circleMarker([p.lat, p.lon], {
      radius: 3, color: '#fbbf24', weight: 1.5, fillOpacity: 1, interactive: false,
    }).addTo(g).bindTooltip(fmt.hhmm(p.t), { className: 'spot-label', direction: 'right', offset: [6, 0] });
  });

  const cfg = stream.config();
  refs.driftInfo.textContent = head;
  refs.driftWarn.textContent = cfg.calibrated
    ? `modèle calibré · ${cfg.observations} relevés`
    : '⚠︎ modèle non calibré — bouton ⏱';
  refs.driftWarn.className = `chip ${cfg.calibrated ? 'good' : 'warn'}`;
  updateReadout();
}

function drawVectors() {
  if (!map || !ui.vectors) return;
  const g = layers.vectors;
  g.clearLayers();
  const b = map.getBounds();
  const field = stream.vectorField(
    { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() },
    Date.now(),
    6, 6,
    state.weather?.hourly || [],
  );
  const max = Math.max(0.4, ...field.map((v) => v.spd));
  for (const v of field) {
    const len = 8 + (v.spd / max) * 22;
    const color = v.sense === 'ebb' ? '#fb923c' : v.sense === 'slack' ? '#64809d' : '#22d3ee';
    L.marker([v.lat, v.lon], {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: `<svg width="44" height="44" viewBox="0 0 44 44" style="transform:rotate(${v.dir}deg);opacity:.85">
          <line x1="22" y1="${22 + len / 2}" x2="22" y2="${22 - len / 2}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M22 ${22 - len / 2 - 1} l-4 6 h8 z" fill="${color}"/></svg>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      }),
    }).addTo(g);
  }
}

function updateReadout() {
  const now = Date.now();
  const fix = state.fix;
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const pos = fix || spots.getPort();
  const st = stream.tidalStream(now, pos);
  const parts = [];
  /* En navigation, la première information n'est plus la position mais le but.
   * Le relevé reste à deux lignes : ce bandeau flotte au-dessus de la carte, et
   * une ligne de plus recouvre justement le marqueur de destination. La
   * position exacte, elle, ne se lit pas ici — elle est dans la pastille GPS,
   * en haut, d'un seul toucher. */
  const sol = state.nav ? route.solve(now) : null;
  if (sol?.ok) {
    parts.push(`🎯 ${state.nav.name} · ${fmt.dist(sol.distanceM)} · cap ${fmt.heading(sol.ctsDeg)}`
      + (sol.etaT ? ` · ${fmt.hhmm(sol.etaT)}` : ''));
  } else if (fix) {
    parts.push(`${fmt.latDDM(fix.lat)} ${fmt.lonDDM(fix.lon)}`);
  }
  parts.push(`${fmt.num(fix?.speedKn, 1)} nd / ${fmt.heading(fix?.cogDeg)}`);
  parts.push(`Courant ${fmt.num(st.spd, 1)} nd ${fmt.cardinal(st.dir)}`);
  if (wx) parts.push(`Vent ${fmt.cardinal(wx.windDirDeg)} ${Math.round(wx.windSpeedKn)}`);
  refs.readout.textContent = parts.join('  ·  ');
}

/* ==========================================================================
 * Interactions
 * ========================================================================== */

/**
 * Bouton 🎯 de la carte. Une route en cours ne s'arrête pas par le même geste
 * qui l'a lancée : on montre d'abord où on en est, et l'arrêt est une décision
 * séparée. Sur un bateau, un appui involontaire ne doit jamais annuler une
 * navigation en cours.
 */
function navButton() {
  if (!state.nav) return void openDestinationPicker();

  const sol = route.solve();
  const body = el('div');
  body.append(el('div', 'list-title', state.nav.name));
  body.append(el('div', 'list-sub', fmt.posDDM(state.nav)));
  if (sol?.ok) {
    const strip = el('div', 'strip');
    strip.style.marginTop = '8px';
    strip.append(pillOf(fmt.dist(sol.distanceM), 'DISTANCE'));
    strip.append(pillOf(fmt.heading(sol.ctsDeg), 'CAP À TENIR'));
    strip.append(pillOf(sol.etaT ? fmt.hhmm(sol.etaT) : '—', 'ARRIVÉE'));
    strip.append(pillOf(sol.ttgMs != null ? fmt.duration(sol.ttgMs) : '—', 'RESTANT'));
    body.append(strip);
    body.append(el('p', 'tiny', route.xteLabel(sol.xteM)));
  }
  const acts = el('div', 'btn-row');
  acts.append(
    button('🎯 Piloter', 'btn-primary', () => {
      closeSheet();
      emit('goto', 'pilot');
    }),
    button('Changer de but', '', () => openDestinationPicker()),
  );
  body.append(acts);
  const stop = button('Arrêter la navigation', 'btn-ghost btn-lg', () => {
    route.stop();
    closeSheet();
    toast('Navigation arrêtée');
  });
  stop.style.marginTop = '8px';
  body.append(stop);
  openSheet('Navigation en cours', body);
}

function onLongPress(latlng) {
  const body = el('div');
  body.append(el('p', 'muted', `${fmt.latDDM(latlng.lat)} ${fmt.lonDDM(latlng.lng)}`));
  if (state.fix) {
    const d = distance(state.fix, { lat: latlng.lat, lon: latlng.lng });
    const b = bearing(state.fix, { lat: latlng.lat, lon: latlng.lng });
    body.append(el('p', 'tiny', `${fmt.dist(d)} au ${fmt.heading(b)} depuis ta position`));
  }
  body.append(button('🎯 Naviguer vers ce point', 'btn-primary btn-lg', () => {
    startNav({ lat: latlng.lat, lon: latlng.lng, name: 'Point carte', kind: 'coord' });
  }));
  body.append(button('🏁 Poser un waypoint (sans piloter)', 'btn-lg', () => {
    set({ waypoint: { lat: latlng.lat, lon: latlng.lng, name: 'Point carte' } });
    closeSheet();
    drawBoat();
    toast('Waypoint posé', 'good');
  }));
  const sep = el('div', 'hr');
  body.append(sep);
  body.append(button('📍 Créer une marque ici', 'btn-lg', () => {
    closeSheet();
    newSpotForm({ lat: latlng.lat, lon: latlng.lng });
  }));
  body.append(button('🎯 Cible de dérive', 'btn-lg', () => {
    ui.target = { lat: latlng.lat, lon: latlng.lng };
    ui.mode = 'reverse';
    closeSheet();
    drawDrift();
  }));
  openSheet('Point de la carte', body);
}

function markHere() {
  if (!state.fix) return void toast('Pas de position GPS', 'danger');
  newSpotForm({ lat: state.fix.lat, lon: state.fix.lon });
}

function newSpotForm(pos) {
  const body = el('div');
  const mk = (label, node) => {
    const f = el('div', 'field');
    f.append(el('label', null, label), node);
    body.append(f);
    return node;
  };

  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Ex. Tête de ridin nord';
  mk('Nom', name);

  const depth = document.createElement('input');
  depth.type = 'number';
  depth.inputMode = 'decimal';
  depth.placeholder = 'Sonde en mètres (carte)';
  mk('Profondeur', depth);

  const habitats = ['epave', 'roche', 'ridin', 'banc-de-sable', 'sable', 'sable-coquillier', 'vase', 'sablo-vaseux', 'chenal', 'tombant', 'veine', 'pleine-eau'];
  const habBox = el('div', 'row wrap');
  const chosen = new Set();
  /* Le fond est PRÉ-COCHÉ depuis la carte EMODnet, jamais imposé : la carte
     est au 1:250 000, une marque relevée au sondeur est plus juste qu'elle.
     L'app propose ce qu'elle sait, l'utilisateur garde le dernier mot. */
  const known = seabed.habitatsAround(pos.lat, pos.lon);
  for (const h of known) chosen.add(h);
  for (const hb of habitats) {
    const b = el('button', 'chip chip-btn', hb);
    b.type = 'button';
    // Les cases pré-remplies depuis EMODnet doivent se VOIR cochées : une
    // sélection en mémoire que l'écran ne montre pas se fait décocher par
    // quelqu'un qui croit la cocher.
    b.classList.toggle('good', chosen.has(hb));
    b.addEventListener('click', () => {
      chosen.has(hb) ? chosen.delete(hb) : chosen.add(hb);
      b.classList.toggle('good', chosen.has(hb));
    });
    habBox.append(b);
  }
  mk('Type de fond', habBox);
  const ground = seabed.at(pos.lat, pos.lon);
  if (ground) {
    body.append(el('p', 'tiny',
      `Fond relevé par EMODnet à cet endroit : ${ground.fr.toLowerCase()} `
      + `(maille ${ground.resolutionM} m — recale si ton sondeur dit autre chose).`));
  }

  const note = document.createElement('textarea');
  note.rows = 3;
  note.placeholder = 'Ce qui marche, quand, avec quoi…';
  mk('Note', note);

  body.append(el('p', 'tiny', `${fmt.latDDM(pos.lat)} ${fmt.lonDDM(pos.lon)}`));
  body.append(button('Enregistrer la marque', 'btn-primary btn-lg', async () => {
    await spots.addSpot({
      name: name.value.trim() || `Marque ${new Date().toLocaleDateString('fr-FR')}`,
      lat: pos.lat,
      lon: pos.lon,
      depthM: depth.value ? [Number(depth.value), Number(depth.value)] : null,
      habitat: [...chosen],
      note: note.value.trim(),
    });
    closeSheet();
    drawSpots();
    toast('Marque enregistrée', 'good');
  }));
  openSheet('Nouvelle marque', body);
}

/**
 * Édition d'une marque existante. Un repère qu'on ne peut plus renommer se
 * fige sur le nom donné à la va-vite le jour où on l'a posé — et six mois plus
 * tard « Marque 12/04 » ne dit plus rien à personne.
 */
function editSpotForm(s) {
  const body = el('div');
  const mk = (label, node) => {
    const f = el('div', 'field');
    f.append(el('label', null, label), node);
    body.append(f);
    return node;
  };

  const name = document.createElement('input');
  name.type = 'text';
  name.value = s.name || '';
  mk('Titre', name);

  const note = document.createElement('textarea');
  note.rows = 4;
  note.value = s.note || '';
  note.placeholder = 'Ce qui marche, quand, avec quoi, la sonde, le fond…';
  mk('Description', note);

  const depth = document.createElement('input');
  depth.type = 'number';
  depth.inputMode = 'decimal';
  depth.value = Array.isArray(s.depthM) ? String(s.depthM[0]) : '';
  depth.placeholder = 'Sonde en mètres (carte)';
  mk('Profondeur', depth);

  body.append(button('Enregistrer', 'btn-primary btn-lg', async () => {
    await spots.updateSpot(s.id, {
      name: name.value.trim() || s.name,
      note: note.value.trim(),
      depthM: depth.value ? [Number(depth.value), Number(depth.value)] : s.depthM,
    });
    closeSheet();
    drawSpots();
    toast('Marque mise à jour', 'good');
  }));
  openSheet('Modifier la marque', body);
}

function showSpot(s) {
  const now = Date.now();
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const body = el('div');

  if (s.seed) {
    const w = el('div', 'banner warn', 'Secteur type : position indicative, à recaler sur tes propres marques.');
    body.append(w);
  }
  if (s.note) body.append(el('p', 'muted', s.note));
  body.append(el('p', 'tiny', `${fmt.latDDM(s.lat)} ${fmt.lonDDM(s.lon)}${
    Array.isArray(s.depthM) ? ` · sonde ${s.depthM[0]}–${s.depthM[1]} m` : ''
  }`));
  // Ce que dit la carte des fonds, à côté de ce que dit la marque. Les deux
  // peuvent diverger, et c'est une information en soi : une tête de roche de
  // vingt mètres n'existe pas dans une carte au 1:250 000.
  const ground = seabed.at(s.lat, s.lon);
  if (ground) body.append(el('p', 'tiny', `Fond cartographié : ${ground.fr.toLowerCase()} (EMODnet, maille ${ground.resolutionM} m)`));

  const drift = stream.driftVector(now, s, wx);
  body.append(el('div', 'hr'));
  body.append(el('div', 'list-title', 'Sur ce poste, maintenant'));
  const strip = el('div', 'strip');
  strip.style.marginTop = '6px';
  strip.append(pillOf(`${fmt.num(drift.spd, 1)} nd`, 'DÉRIVE'));
  strip.append(pillOf(fmt.cardinal(drift.dir), 'VERS'));
  strip.append(pillOf(fmt.num(drift.stream.spd, 1), 'COURANT'));
  if (Array.isArray(s.depthM)) {
    const wl = s.depthM[1] + tide.height(now);
    strip.append(pillOf(`${fmt.num(wl, 1)} m`, "HAUTEUR D'EAU"));
  }
  body.append(strip);

  const wat = spots.windAgainstTide(wx?.windDirDeg, wx?.windSpeedKn, drift.stream.dir, drift.stream.spd);
  if (wat.opposed) body.append(el('div', 'banner warn', wat.label));

  body.append(el('div', 'hr'));
  const acts = el('div', 'btn-row');
  acts.append(
    button('🎯 Naviguer', 'btn-primary', () => {
      startNav({ lat: s.lat, lon: s.lon, name: s.name, note: s.note, id: s.id, kind: 'spot' });
    }),
    button('⤵ Dérive vers', '', () => {
      ui.target = { lat: s.lat, lon: s.lon };
      ui.mode = 'reverse';
      closeSheet();
      drawDrift();
    }),
  );
  body.append(acts);

  const edit = button('✎ Renommer / éditer la note', 'btn-sm', () => editSpotForm(s));
  edit.style.marginTop = '8px';
  if (!s.seed) body.append(edit);

  if (!s.seed) {
    const del = button('Supprimer la marque', 'btn-ghost btn-sm', async () => {
      await spots.removeSpot(s.id);
      closeSheet();
      drawSpots();
      toast('Marque supprimée');
    });
    del.style.marginTop = '10px';
    body.append(del);
  }
  openSheet(s.name, body);
}

function pillOf(v, l) {
  const p = el('div', 'pill');
  p.append(el('div', 'pill-val', v), el('div', 'pill-lbl', l));
  return p;
}

/* ==========================================================================
 * Relevé de dérive — la boucle de calibration
 * ========================================================================== */
async function recordDrift() {
  const fix = state.fix;
  if (!fix || !Number.isFinite(fix.speedKn) || !Number.isFinite(fix.cogDeg)) {
    return void toast('Il faut une position et une route stables', 'danger');
  }
  if (fix.speedKn > 5) return void toast('Trop rapide — relève moteur coupé', 'danger');

  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, Date.now()) : null;
  const n = await learning.logDrift({
    t: Date.now(),
    lat: fix.lat,
    lon: fix.lon,
    dirDeg: fix.cogDeg,
    spdKn: fix.speedKn,
    windSpeedKn: wx?.windSpeedKn,
    windDirDeg: wx?.windDirDeg,
  });
  const m = await learning.recompute();
  toast(
    m.drift?.calibrated
      ? `Relevé ${n} · modèle recalibré (${m.drift.knPerMPerHour} nd par m/h)`
      : `Relevé ${n} enregistré`,
    'good',
  );
  drawDrift();
}

function exportGPX() {
  const wpts = spots.personalSpots().map((s) => ({ lat: s.lat, lon: s.lon, name: s.name, desc: s.note }));

  // Les prises partent aussi en waypoints, avec leur contexte en description :
  // un GPX doit pouvoir se relire dans OpenCPN ou Navionics sans cette app.
  for (const c of catchCache) {
    const info = record.speciesInfo(c.speciesId, c.speciesName);
    const s = c.snapshot || {};
    wpts.push({
      lat: c.lat,
      lon: c.lon,
      name: `${info.name}${c.lengthCm ? ` ${c.lengthCm}cm` : ''} ${fmt.hhmm(c.t)}`,
      desc: [
        new Date(c.t).toLocaleString('fr-FR'),
        c.released ? 'relâché' : 'gardé',
        s.coefficient != null ? `coef ${s.coefficient}` : null,
        s.heightM != null ? `hauteur ${s.heightM} m` : null,
        s.tideSense ? `marée ${s.tideSense}` : null,
        s.driftKn != null ? `dérive ${s.driftKn} nd` : null,
        s.seaTempC != null ? `eau ${s.seaTempC} °C` : null,
        s.windSpeedKn != null ? `vent ${Math.round(s.windSpeedKn)} nd` : null,
        c.note || null,
      ].filter(Boolean).join(' · '),
    });
  }

  const tracks = gps.track.length > 1 ? [{ name: `Sortie ${new Date().toLocaleDateString('fr-FR')}`, points: gps.track }] : [];
  if (!wpts.length && !tracks.length) return void toast('Rien à exporter');
  const blob = new Blob([toGPX(tracks, wpts)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `grims-${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ==========================================================================
 * Préchargement des tuiles
 * ========================================================================== */
async function downloadZone() {
  const b = map.getBounds();
  const zooms = [10, 11, 12, 13, 14];
  const jobs = [];
  for (const z of zooms) {
    const nw = deg2tile(b.getNorth(), b.getWest(), z);
    const se = deg2tile(b.getSouth(), b.getEast(), z);
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        jobs.push({ z, x, y });
      }
    }
  }
  const total = jobs.length * 2; // fond + balisage
  if (total > 4000) {
    return void toast('Zone trop large — zoome un peu avant de télécharger', 'danger');
  }

  const q = await idb.quota();
  const body = el('div');
  body.append(el('p', 'muted', `${total} tuiles (fond + balisage) sur la zone affichée, zooms 10 à 14. Environ ${Math.round(total * 14 / 1024)} Mo.`));
  if (q) body.append(el('p', 'tiny', `Espace utilisé : ${(q.usage / 1e6).toFixed(0)} Mo sur ${(q.quota / 1e6).toFixed(0)} Mo disponibles.`));
  const bar = el('div', 'fbar-track');
  bar.style.height = '8px';
  const fill = el('div', 'fbar-fill');
  fill.style.background = '#22d3ee';
  fill.style.width = '0%';
  bar.append(fill);
  const status = el('div', 'tiny', '');
  body.append(bar, status);

  let cancelled = false;
  const go = button('Lancer le téléchargement', 'btn-primary btn-lg', async () => {
    go.disabled = true;
    let done = 0;
    let failed = 0;
    for (const job of jobs) {
      if (cancelled) break;
      for (const [key, tpl] of [
        ['osm', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        ['seamark', 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
      ]) {
        const k = `${key}/${job.z}/${job.x}/${job.y}`;
        done++;
        if (await idb.get('tiles', k)) continue;
        try {
          const url = tpl.replace('{z}', job.z).replace('{x}', job.x).replace('{y}', job.y);
          const r = await fetch(url, { mode: 'cors' });
          if (r.ok) await idb.put('tiles', k, await r.blob());
          else failed++;
        } catch {
          failed++;
        }
      }
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      status.textContent = `${done} / ${total}${failed ? ` · ${failed} échecs` : ''}`;
      // Respiration : sans ça l'UI se fige et iOS tue l'onglet.
      if (done % 12 === 0) await new Promise((r) => setTimeout(r, 40));
    }
    toast(cancelled ? 'Téléchargement interrompu' : `Zone en cache (${done - failed} tuiles)`, 'good');
    closeSheet();
  });
  body.append(go);

  const sheet = openSheet('Précharger la zone', body);
  document.getElementById('sheet-close').addEventListener('click', () => (cancelled = true), { once: true });
  return sheet;
}

function deg2tile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/* ==========================================================================
 * Prises
 * --------------------------------------------------------------------------
 * Une prise, c'est d'abord un POINT. Un carnet qui ne les montre pas sur l'eau
 * n'apprend rien à personne : c'est en voyant les marqueurs se grouper sur une
 * tête de ridin qu'on comprend son spot. Chaque espèce a sa couleur, la taille
 * du marqueur suit le nombre de poissons, et les prises relâchées sont
 * distinguées — on veut voir où ça mord, pas seulement où on a rempli la glacière.
 * ========================================================================== */
let catchCache = [];

export async function drawCatches() {
  if (!map || !layers.catches) return;
  catchCache = (await learning.catches()).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  const g = layers.catches;
  g.clearLayers();
  if (!ui.catches) return;

  // Les prises du jour ressortent : c'est la sortie en cours qui intéresse.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  for (const c of catchCache) {
    const info = record.speciesInfo(c.speciesId, c.speciesName);
    const today = c.t >= dayStart.valueOf();
    const size = 24 + Math.min(10, ((c.count || 1) - 1) * 3);

    const marker = L.marker([c.lat, c.lon], {
      zIndexOffset: today ? 600 : 400,
      icon: L.divIcon({
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size],
        html: `<div class="catch-marker" style="width:${size}px;height:${size}px;`
          + `background:${info.color};opacity:${today ? 1 : 0.62};`
          + `${c.released ? 'border-style:dashed;' : ''}">`
          + `<span>${info.emoji}</span></div>`,
      }),
    }).addTo(g);

    marker.bindTooltip(
      `${info.name}${c.lengthCm ? ` ${c.lengthCm} cm` : ''}${(c.count || 1) > 1 ? ` ×${c.count}` : ''}`,
      { className: 'spot-label', direction: 'top', offset: [0, -size] },
    );
    marker.on('click', (e) => {
      L.DomEvent.stop(e);
      showCatch(c, info);
    });
  }
}

function showCatch(c, info) {
  const body = el('div');
  const head = el('div', 'row');
  const badge = el('div', 'score-badge');
  badge.style.background = info.color;
  badge.style.color = '#050b14';
  badge.textContent = info.emoji;
  head.append(badge);
  const main = el('div', 'list-main');
  main.append(el('div', 'list-title',
    `${info.name}${c.lengthCm ? ` · ${c.lengthCm} cm` : ''}${(c.count || 1) > 1 ? ` ×${c.count}` : ''}`));
  main.append(el('div', 'list-sub',
    `${new Date(c.t).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    + `${c.released ? ' · relâché' : ''}`));
  head.append(main);
  body.append(head);

  if (c.note) body.append(el('p', 'muted', c.note));
  body.append(el('div', 'hr'));
  body.append(record.renderSnapshot(c.snapshot));

  const acts = el('div', 'btn-row');
  acts.append(
    button('🎯 Y retourner', 'btn-primary', () => {
      startNav({
        lat: c.lat,
        lon: c.lon,
        name: `${info.name} ${new Date(c.t).toLocaleDateString('fr-FR')}`,
        kind: 'catch',
      });
    }),
    button('⤵ Dérive vers ici', '', () => {
      ui.target = { lat: c.lat, lon: c.lon };
      ui.mode = 'reverse';
      closeSheet();
      drawDrift();
    }),
    button('📍 En faire une marque', '', async () => {
      await spots.addSpot({
        name: `${info.name} ${new Date(c.t).toLocaleDateString('fr-FR')}`,
        lat: c.lat,
        lon: c.lon,
        note: `Prise enregistrée le ${new Date(c.t).toLocaleString('fr-FR')}.`,
        habitat: c.snapshot?.nearestSpot ? [] : [],
      });
      closeSheet();
      drawSpots();
      toast('Marque créée sur la prise', 'good');
    }),
  );
  body.append(acts);

  openSheet('Prise', body);
}

/* Rafraîchit les prises quand on en enregistre une, depuis n'importe quel écran. */
on('catches:changed', () => map && drawCatches());

/* ==========================================================================
 * Arrivée : la carte prend du recul
 * --------------------------------------------------------------------------
 * Pendant la route, la carte est serrée sur le bateau — c'est ce qu'on veut
 * quand on suit un cap. À l'arrivée, la question change du tout au tout : on
 * ne demande plus « où vais-je » mais « qu'est-ce qu'il y a autour de moi » —
 * les casiers, le haut-fond, les autres bateaux, la place pour manœuvrer.
 * On dézoome donc sur la zone d'arrivée, et on coupe le suivi automatique pour
 * que la carte arrête de fuir sous le doigt pendant la manœuvre.
 * ========================================================================== */
on('nav:arrived', () => {
  if (!map || !state.nav) return;
  setFollow(false);
  const pts = [[state.nav.lat, state.nav.lon]];
  if (state.fix) pts.push([state.fix.lat, state.fix.lon]);
  map._programmaticMove = true;
  map.flyToBounds(L.latLngBounds(pts).pad(1.2), {
    maxZoom: 15,
    padding: [60, 60],
    duration: 1.1,
  });
  setTimeout(() => (map._programmaticMove = false), 1600);
});

on('nav:start', () => {
  if (!map) return;
  refs.btnNav?.classList.add('on');
  drawRoute();
});
on('nav:stop', () => {
  if (!map) return;
  refs.btnNav?.classList.remove('on');
  drawRoute();
});

/* Rafraîchit les marques quand elles changent ailleurs (import GPX, journal). */
on('spots:changed', () => map && drawSpots());

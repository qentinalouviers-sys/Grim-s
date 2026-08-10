/* ==========================================================================
 * views/nav.js — mode NAVIGATION
 * --------------------------------------------------------------------------
 * L'écran qu'on regarde en tenant la barre. Règle : tout ce qui compte tient
 * sans défilement, et se lit à bout de bras.
 *
 * Hiérarchie assumée, de haut en bas :
 *   1. vitesse et vent — ce qui décide si on continue
 *   2. cap — ce qui décide où on va
 *   3. marée et courant — ce qui décide quand
 *   4. le conseil du guide — ce qui décide quoi faire
 *   5. les actions d'urgence — mouillage, retour, MOB
 * ========================================================================== */

import { state, subscribe, set, emit } from '../core/store.js';
import { el, pill, button, toast, openSheet, clear } from '../ui/dom.js';
import { Gauge, Compass, TideChart, StreamProfile, CurrentRose } from '../ui/widgets.js';
import * as fmt from '../core/fmt.js';
import { bearing, distance, angleDiff } from '../core/geo.js';
import * as tide from '../data/tide.js';
import * as stream from '../data/stream.js';
import * as weather from '../data/weather.js';
import * as gps from '../sensors/gps.js';
import * as spots from '../fishing/spots.js';
import { sunTimes, moonPhase } from '../data/astro.js';

const HOUR = 3600000;

let root;
let unsub;
let widgets = {};
let refs = {};
let timer = 0;

export function mount(container) {
  root = clear(container);

  /* ---- Vitesse / vent ------------------------------------------------- */
  const gaugeRow = el('div', 'gauge-pair');
  const gSpeed = el('div', 'gauge-wrap');
  const gWind = el('div', 'gauge-wrap');
  gaugeRow.append(gSpeed, gWind);

  const speedCard = el('div', 'card tight');
  speedCard.append(gaugeRow);
  const gaugeLabels = el('div', 'gauge-pair');
  refs.speedLbl = el('div', 'metric-lbl', 'VITESSE FOND');
  refs.windLbl = el('div', 'metric-lbl', 'VENT');
  gaugeLabels.append(refs.speedLbl, refs.windLbl);
  speedCard.append(gaugeLabels);
  root.append(speedCard);

  widgets.speed = new Gauge(gSpeed, { size: 128, max: 12, color: '#22d3ee', unit: 'nd', decimals: 1 });
  widgets.wind = new Gauge(gWind, { size: 128, max: 40, color: '#a78bfa', unit: 'nd', decimals: 0, ticks: 8 });

  /* ---- Compas ---------------------------------------------------------- */
  const compassCard = el('div', 'card tight');
  const cWrap = el('div');
  compassCard.append(cWrap);
  widgets.compass = new Compass(cWrap, { height: 128 });

  refs.headRow = el('div', 'row');
  refs.headVal = el('div', 'metric-val sm c-cyan tnum', '—––°');
  refs.headSrc = el('div', 'tiny');
  refs.headRow.append(refs.headVal, refs.headSrc, el('div', 'spacer'));
  refs.headExtra = el('div', 'tiny');
  refs.headRow.append(refs.headExtra);
  compassCard.append(refs.headRow);
  root.append(compassCard);

  /* ---- Bandeau d'infos ------------------------------------------------- */
  refs.strip = el('div', 'strip');
  const stripCard = el('div', 'card tight');
  stripCard.append(refs.strip);
  root.append(stripCard);

  /* ---- Marée ----------------------------------------------------------- */
  const tideCard = el('div', 'card');
  const tideHead = el('div', 'card-head');
  refs.tideTitle = el('h3', null, 'MARÉE');
  refs.tideSource = el('span', 'chip', '—');
  tideHead.append(refs.tideTitle, el('div', 'spacer'), refs.tideSource);
  tideCard.append(tideHead);
  const tideWrap = el('div');
  tideCard.append(tideWrap);
  widgets.tide = new TideChart(tideWrap, { height: 100 });
  refs.tideNext = el('div', 'strip');
  refs.tideNext.style.marginTop = '8px';
  tideCard.append(refs.tideNext);
  root.append(tideCard);

  /* ---- Courant --------------------------------------------------------- */
  const curCard = el('div', 'card');
  const curHead = el('div', 'card-head');
  curHead.append(el('h3', null, 'COURANT & DÉRIVE'), el('div', 'spacer'));
  refs.curCalib = el('span', 'chip', '');
  curHead.append(refs.curCalib);
  curCard.append(curHead);

  const curGrid = el('div', 'row');
  const roseWrap = el('div');
  roseWrap.style.width = '124px';
  roseWrap.style.flex = '0 0 auto';
  const curInfo = el('div');
  curInfo.style.flex = '1';
  curGrid.append(roseWrap, curInfo);
  curCard.append(curGrid);
  widgets.rose = new CurrentRose(roseWrap, { height: 118 });
  refs.curInfo = curInfo;

  const profWrap = el('div');
  profWrap.style.marginTop = '6px';
  curCard.append(profWrap);
  widgets.profile = new StreamProfile(profWrap, { height: 74 });
  root.append(curCard);

  /* ---- Conseil --------------------------------------------------------- */
  refs.advice = el('div', 'card');
  root.append(refs.advice);

  /* ---- Actions --------------------------------------------------------- */
  const actions = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'ACTIONS'));
  actions.append(head);

  const row1 = el('div', 'btn-row');
  refs.btnAnchor = button('⚓ Mouillage', '', toggleAnchor);
  refs.btnTrip = button('▶︎ Sortie', '', toggleTrip);
  row1.append(refs.btnAnchor, refs.btnTrip);

  const row2 = el('div', 'btn-row');
  row2.style.marginTop = '8px';
  refs.btnHome = button('🏠 Retour port', '', () => {
    const p = spots.getPort();
    set({ waypoint: { lat: p.lat, lon: p.lon, name: p.name } });
    toast(`Route sur ${p.name}`, 'good');
  });
  refs.btnDrift = button('⏱ Relever dérive', '', () => emit('drift:record'));
  row2.append(refs.btnHome, refs.btnDrift);

  actions.append(row1, row2);
  refs.tripInfo = el('div', 'tiny');
  refs.tripInfo.style.marginTop = '8px';
  actions.append(refs.tripInfo);
  root.append(actions);

  root.append(el('div', 'tiny', 'Les données affichées ne remplacent pas les documents nautiques officiels. Marée : SHOM. Météo : Open-Meteo.'));

  unsub = subscribe(
    ['fix', 'heading', 'tide', 'weather', 'trip', 'anchor', 'waypoint', 'advice', 'motion'],
    render,
  );
  timer = setInterval(render, 5000);
  render();
}

export function unmount() {
  unsub?.();
  clearInterval(timer);
  Object.values(widgets).forEach((wgt) => wgt.destroy?.());
  widgets = {};
  refs = {};
}

/* ==========================================================================
 * Rendu
 * ========================================================================== */

function render() {
  const now = Date.now();
  const fix = state.fix;
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const pos = fix ? { lat: fix.lat, lon: fix.lon } : spots.getPort();

  /* ---- Jauges ---------------------------------------------------------- */
  widgets.speed.set(fix?.speedKn ?? null);
  refs.speedLbl.textContent = fix
    ? `VITESSE FOND · ±${Math.round(fix.accuracy || 0)} m`
    : 'VITESSE FOND · sans position';

  widgets.wind.set(wx?.windSpeedKn ?? null, wx ? fmt.cardinal(wx.windDirDeg) : '');
  refs.windLbl.textContent = wx
    ? `VENT ${fmt.cardinal(wx.windDirDeg)} · F${fmt.beaufort(wx.windSpeedKn)}${
        wx.windGustKn > wx.windSpeedKn + 4 ? ` · raf ${Math.round(wx.windGustKn)}` : ''
      }`
    : 'VENT · indisponible';

  /* ---- Compas ---------------------------------------------------------- */
  const hd = state.heading;
  const marks = [];
  if (state.waypoint && fix) {
    marks.push({ deg: bearing(fix, state.waypoint), color: '#a3e635', label: 'WPT' });
  }
  if (state.mob && fix) {
    marks.push({ deg: bearing(fix, state.mob), color: '#fb5a72', label: 'MOB' });
  }
  const st = stream.tidalStream(now, pos);
  marks.push({ deg: st.dir, color: st.sense === 'ebb' ? '#fb923c' : '#22d3ee', label: 'CRT' });

  if (hd) {
    widgets.compass.set(hd.deg, marks, hd.quality);
    refs.headVal.textContent = fmt.heading(hd.deg);
    refs.headSrc.textContent =
      hd.source === 'compass' ? `compas · ${qualityLabel(hd.quality)}`
      : hd.source === 'cog' ? 'route fond GPS'
      : 'compas figé';
    refs.headExtra.textContent = hd.deviation
      ? `déviation ${hd.deviation > 0 ? '+' : ''}${hd.deviation}° / route`
      : hd.tilted ? 'téléphone trop incliné'
      : `mag ${fmt.heading(hd.magnetic ?? hd.deg)}`;
  } else {
    refs.headVal.textContent = '—––°';
    refs.headSrc.textContent = 'compas inactif';
    refs.headExtra.textContent = '';
  }

  /* ---- Bandeau --------------------------------------------------------- */
  const strip = clear(refs.strip);
  const sun = sunTimes(new Date(now), pos.lat, pos.lon);
  const moon = moonPhase(new Date(now));

  strip.append(pill(wx?.seaTempC != null ? `${fmt.num(wx.seaTempC, 1)}°` : '—', '🌡 EAU'));
  strip.append(pill(wx?.pressureHpa != null ? Math.round(wx.pressureHpa) : '—', '🔽 hPa'));
  strip.append(pill(
    state.motion?.hsEstimateM != null ? `${fmt.num(state.motion.hsEstimateM, 1)} m`
      : wx?.waveHeightM != null ? `${fmt.num(wx.waveHeightM, 1)} m` : '—',
    state.motion?.hsEstimateM != null ? '🌊 BORD' : '🌊 MER',
  ));
  strip.append(pill(`${Math.round(moon.illumination * 100)}%`, '🌙 LUNE'));
  strip.append(pill(fmt.hhmm(sun.sunriseT), '☀️ LEVER'));
  strip.append(pill(fmt.hhmm(sun.sunsetT), '🌇 COUCHER'));
  if (fix) strip.append(pill(fmt.posDDM(fix).split(' ')[0], '📍 LAT'));
  if (fix) strip.append(pill(fmt.posDDM(fix).split(' ')[1], '📍 LON'));

  /* ---- Marée ----------------------------------------------------------- */
  const info = tide.info(now);
  refs.tideSource.textContent = info.label;
  refs.tideSource.className = `chip ${info.trust === 'high' ? 'good' : info.trust === 'low' ? 'warn' : ''}`;
  refs.tideSource.title = info.detail;

  const series = tide.series(now - 6 * HOUR, now + 18 * HOUR, 10 * 60000);
  const ext = tide.extrema(now - 6 * HOUR, now + 18 * HOUR);
  widgets.tide.set({ series, extrema: ext, now });

  const nextTides = clear(refs.tideNext);
  nextTides.append(pill(`${fmt.num(tide.height(now), 2)} m`, 'HAUTEUR', 'c-cyan'));
  nextTides.append(pill(String(tide.coefficient(now)), 'COEF', coefClass(tide.coefficient(now))));
  for (const e of tide.next(now, 3)) {
    nextTides.append(pill(
      `${info.provisional ? '≈' : ''}${fmt.hhmm(e.t)}`,
      `${e.kind === 'HW' ? 'PM' : 'BM'} ${fmt.num(e.heightM, 1)}m`,
      e.kind === 'HW' ? 'c-lime' : 'c-amber',
    ));
  }

  /* ---- Courant --------------------------------------------------------- */
  const drift = stream.driftVector(now, pos, wx);
  widgets.rose.set(
    { dir: drift.dir, spd: drift.spd, sense: drift.sense },
    wx ? { dir: wx.windDirDeg, spd: wx.windSpeedKn } : null,
    hd?.deg,
  );

  const cfg = stream.config();
  refs.curCalib.textContent = cfg.calibrated ? `calibré · ${cfg.observations} relevés` : 'non calibré';
  refs.curCalib.className = `chip ${cfg.calibrated ? 'good' : 'warn'}`;

  const ci = clear(refs.curInfo);
  ci.append(kv('Courant marée', `${fmt.num(st.spd, 1)} nd → ${fmt.heading(st.dir)} ${fmt.cardinal(st.dir)}`));
  ci.append(kv('Régime', senseLabel(st.sense)));
  ci.append(kv('Dérive bateau', `${fmt.num(drift.spd, 1)} nd → ${fmt.heading(drift.dir)}`));
  if (drift.leeway && drift.leeway.spd > 0.05) {
    ci.append(kv('dont fardage', `${fmt.num(drift.leeway.spd, 1)} nd`));
  }
  ci.append(kv('Étale', `${fmt.hhmm(st.slackT)} · ${fmt.countdown(st.slackT - now)}`));
  if (fix?.moving && Number.isFinite(fix.cogDeg) && hd?.source === 'compass') {
    const setDrift = Math.round(angleDiff(fix.cogDeg, hd.deg));
    ci.append(kv('Dérive constatée', `${setDrift > 0 ? '+' : ''}${setDrift}° cap/route`));
  }

  widgets.profile.set(stream.dailyProfile(now - 2 * HOUR, 24, 15, pos), now);

  /* ---- Conseil --------------------------------------------------------- */
  renderAdvice();

  /* ---- Actions --------------------------------------------------------- */
  refs.btnAnchor.textContent = state.anchor?.armed ? '⚓ Lever la veille' : '⚓ Mouillage';
  refs.btnAnchor.className = `btn ${state.anchor?.armed ? 'btn-lime' : ''}`;
  refs.btnTrip.textContent = state.trip ? '⏹ Fin de sortie' : '▶︎ Sortie';
  refs.btnTrip.className = `btn ${state.trip ? 'btn-lime' : ''}`;

  const parts = [];
  if (state.trip) {
    parts.push(`Sortie : ${fmt.dist(state.trip.distanceM)} · ${fmt.duration(now - state.trip.startedAt)} · max ${fmt.num(state.trip.maxSpeedKn, 1)} nd`);
  }
  if (state.anchor?.armed && fix) {
    parts.push(`Mouillage : ${Math.round(distance(state.anchor, fix))} m du point / rayon ${state.anchor.radiusM} m`);
  }
  if (state.waypoint && fix) {
    const d = distance(fix, state.waypoint);
    const b = bearing(fix, state.waypoint);
    const eta = fix.speedKn > 0.5 ? fmt.duration((d / 1852 / fix.speedKn) * HOUR) : '—';
    parts.push(`→ ${state.waypoint.name} : ${fmt.dist(d)} au ${fmt.heading(b)} · ETA ${eta}`);
  }
  refs.tripInfo.textContent = parts.join('\n') || 'Aucune veille active.';
  refs.tripInfo.style.whiteSpace = 'pre-line';
}

function renderAdvice() {
  const box = clear(refs.advice);
  const a = state.advice;
  const head = el('div', 'card-head');
  head.append(el('h3', null, '🐟 LE GUIDE'));
  box.append(head);

  if (!a) {
    box.append(el('div', 'muted', 'Calcul en cours…'));
    return;
  }
  box.append(el('div', 'list-title', a.headline));
  if (a.subline) box.append(el('div', 'list-sub', a.subline));

  const danger = a.warnings?.find((w) => w.level === 'danger') || a.warnings?.find((w) => w.level === 'warn');
  if (danger) {
    const warn = el('div', `banner ${danger.level}`, danger.text);
    warn.style.marginTop = '8px';
    box.append(warn);
  }

  const go = button('Ouvrir le mode pêche →', 'btn-sm', () => emit('goto', 'fish'));
  go.style.marginTop = '10px';
  box.append(go);
}

/* ==========================================================================
 * Actions
 * ========================================================================== */

function toggleAnchor() {
  if (state.anchor?.armed) {
    gps.weighAnchor();
    toast('Veille de mouillage levée');
    return;
  }
  if (!state.fix) return void toast('Pas de position GPS', 'danger');

  const body = el('div');
  body.append(el('p', 'muted', "Le cercle est centré sur la position actuelle. Compte la longueur de chaîne mouillée plus la longueur du bateau, et ajoute la précision GPS."));
  const field = el('div', 'field');
  field.append(el('label', null, 'Rayon d’alarme (mètres)'));
  const input = document.createElement('input');
  input.type = 'number';
  input.value = '50';
  input.min = '15';
  input.max = '300';
  input.inputMode = 'numeric';
  field.append(input);
  body.append(field);
  body.append(button('Armer la veille', 'btn-primary btn-lg', () => {
    gps.dropAnchor(Math.max(15, Math.min(300, Number(input.value) || 50)));
    toast('Veille de mouillage armée', 'good');
    document.getElementById('sheet-backdrop').hidden = true;
  }));
  openSheet('Veille de mouillage', body);
}

function toggleTrip() {
  if (state.trip) {
    const t = gps.stopTrip();
    emit('trip:saved', t);
    toast(`Sortie terminée : ${fmt.dist(t?.distanceM || 0)}`, 'good');
  } else {
    gps.startTrip();
    toast('Enregistrement de la sortie', 'good');
  }
}

/* ==========================================================================
 * Utilitaires
 * ========================================================================== */

function kv(label, value) {
  const row = el('div', 'row');
  row.style.justifyContent = 'space-between';
  row.style.padding = '2px 0';
  row.append(el('span', 'tiny', label), el('span', 'tnum', value));
  row.lastChild.style.fontSize = '13px';
  row.lastChild.style.fontWeight = '650';
  return row;
}

const senseLabel = (s) => (s === 'flood' ? 'Montant (flot)' : s === 'ebb' ? 'Descendant (jusant)' : 'Étale');

const qualityLabel = (q) =>
  ({ good: 'stable', fair: 'moyen', poor: 'bruité', bad: 'à plat !', stale: 'figé' }[q] || q);

function coefClass(c) {
  if (c >= 95) return 'c-red';
  if (c >= 70) return 'c-lime';
  if (c >= 45) return 'c-cyan';
  return 'c-dim';
}

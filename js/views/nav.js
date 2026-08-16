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
 *   5. les actions d'urgence — alerte mouillage, retour, MOB
 * ========================================================================== */

import { state, subscribe, emit } from '../core/store.js';
import { APP_VERSION } from '../core/build.js';
import { el, pill, button, toast, openSheet, clear } from '../ui/dom.js';
import { Gauge, Compass, TideChart, StreamProfile, CurrentRose } from '../ui/widgets.js';
import * as fmt from '../core/fmt.js';
import { bearing, distance, angleDiff } from '../core/geo.js';
import * as tide from '../data/tide.js';
import * as stream from '../data/stream.js';
import * as weather from '../data/weather.js';
import * as gps from '../sensors/gps.js';
import * as compass from '../sensors/heading.js';
import * as spots from '../fishing/spots.js';
import * as route from '../nav/route.js';
import { openDestinationPicker } from '../ui/destination.js';
import { openDriveChooser } from './drive.js';
import { sunTimes, moonPhase } from '../data/astro.js';

const HOUR = 3600000;

let root;
let unsubs = [];
let widgets = {};
let refs = {};
let timer = 0;
// Relèvements portés sur le cadran (waypoint, MOB, courant). Ils dépendent de
// la position et de l'heure, pas du cap : on les recalcule au rythme du GPS et
// le rendu du compas se contente de les réafficher.
let marks = [];

export function mount(container) {
  root = clear(container);

  /* ---- Vitesse / vent ------------------------------------------------- */
  const gaugeRow = el('div', 'gauge-pair');
  const gSpeed = el('div', 'gauge-wrap');
  const gWind = el('div', 'gauge-wrap');
  gaugeRow.append(gSpeed, gWind);

  const speedCard = el('div', 'card tight');
  speedCard.append(gaugeRow);
  /* Titre et qualificatif sur deux lignes DÉLIBÉRÉES. En une seule chaîne,
   * « VITESSE FOND · ±10 M » repassait à la ligne tout seul, en capitales
   * espacées, coupé n'importe où — deux cadrans côte à côte n'ont pas la
   * largeur d'une phrase. */
  const gaugeLabels = el('div', 'gauge-pair');
  const speedCol = el('div');
  const windCol = el('div');
  refs.speedLbl = el('div', 'metric-lbl', 'VITESSE FOND');
  refs.speedQual = el('div', 'metric-qual', 'sans position');
  refs.windLbl = el('div', 'metric-lbl', 'VENT');
  refs.windQual = el('div', 'metric-qual', 'indisponible');
  speedCol.append(refs.speedLbl, refs.speedQual);
  windCol.append(refs.windLbl, refs.windQual);
  gaugeLabels.append(speedCol, windCol);
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
  // Toucher le compas ouvre son diagnostic. Un cap qui traîne peut venir du
  // capteur, de l'autorisation, du référentiel ou de la ferraille du bord :
  // sans mesure affichée, on corrige au hasard.
  compassCard.style.cursor = 'pointer';
  compassCard.addEventListener('click', openCompassDiag);
  root.append(compassCard);

  /* ---- Actions ---------------------------------------------------------
   * Elles vivent ICI, juste sous le compas, et c'est un choix de mer : le tour
   * d'audit a mesuré quatre écrans et demi de défilement pour atteindre
   * « Naviguer », « Alerte mouillage » ou « Retour port ». À bord, une commande
   * qu'on ne trouve pas sous le pouce n'existe pas. Marée, courant et conseil restent
   * en dessous : ils se consultent, ils ne s'actionnent pas. */
  const actions = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'ACTIONS'));
  actions.append(head);

  // La navigation GPS est l'action la plus lourde de conséquences de cet
  // écran : elle occupe toute la largeur, seule, et se lit sans chercher.
  /* Le mode conduite passe DEVANT « Naviguer vers… », et ce n'est pas une
   * promotion arbitraire : « naviguer vers » demande déjà de savoir où l'on
   * va, alors que la plupart des sorties commencent sans but — on largue les
   * amarres, on verra sur l'eau. Le mode conduite accepte les deux, et c'est
   * lui qui pose la question. */
  refs.btnDrive = button('🛞 Mode conduite', 'btn-primary btn-lg', openDriveChooser);
  actions.append(refs.btnDrive);

  refs.btnGo = button('🎯 Naviguer vers…', 'btn-lg', () => openDestinationPicker());
  refs.btnGo.style.marginTop = '8px';
  actions.append(refs.btnGo);

  const row1 = el('div', 'btn-row');
  row1.style.marginTop = '8px';
  refs.btnAnchor = button('⚓ Alerte mouillage', '', toggleAnchor);
  refs.btnTrip = button('▶︎ Sortie', '', toggleTrip);
  row1.append(refs.btnAnchor, refs.btnTrip);

  const row2 = el('div', 'btn-row');
  row2.style.marginTop = '8px';
  refs.btnHome = button('🏠 Retour port', '', () => {
    const p = spots.getPort();
    route.start({ lat: p.lat, lon: p.lon, name: p.name, kind: 'port' });
  });
  refs.btnDrift = button('⏱ Relever dérive', '', () => emit('drift:record'));
  row2.append(refs.btnHome, refs.btnDrift);

  actions.append(row1, row2);
  refs.tripInfo = el('div', 'tiny');
  refs.tripInfo.style.marginTop = '8px';
  actions.append(refs.tripInfo);
  root.append(actions);


  /* ---- Bandeau d'infos ------------------------------------------------- */
  refs.strip = el('div', 'strip');
  const stripWrap = el('div', 'strip-wrap');
  stripWrap.append(refs.strip);
  const stripCard = el('div', 'card tight');
  stripCard.append(stripWrap);
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

  root.append(el('div', 'tiny', 'Les données affichées ne remplacent pas les documents nautiques officiels. Marée : SHOM. Météo : Open-Meteo.'));

  /* ---- Abonnements : trois rythmes, pas un seul ------------------------
   *
   * Le compas parle jusqu'à 60 fois par seconde. Le brancher sur le rendu
   * complet — c'était le cas — faisait redessiner six canvas et reconstruire
   * quarante nœuds de DOM à chaque frémissement du magnétomètre : l'aiguille
   * accusait alors un demi-tour de retard sur le bateau. Chaque donnée est
   * désormais rendue au rythme auquel elle change réellement.
   */
  unsubs.push(subscribe('heading', renderHeading));           // ~60 Hz, très court
  unsubs.push(subscribe('fix', renderKinetics));              // 1 Hz
  unsubs.push(subscribe(
    ['tide', 'weather', 'trip', 'anchor', 'waypoint', 'advice', 'motion'],
    render,
  ));
  timer = setInterval(render, 5000);
  render();
}

export function unmount() {
  unsubs.forEach((fn) => fn());
  unsubs = [];
  clearInterval(timer);
  Object.values(widgets).forEach((wgt) => wgt.destroy?.());
  widgets = {};
  refs = {};
}

/* ==========================================================================
 * Rendu
 * ========================================================================== */

/**
 * Rendu du compas seul. C'est le chemin chaud : il doit rester en dessous du
 * budget d'une frame. Un dessin de cadran et trois nœuds de texte, rien
 * d'autre — aucun calcul de marée, de courant ni de mise en page.
 */
function renderHeading() {
  const hd = state.heading;
  if (!refs.headVal) return;

  if (!hd) {
    refs.headVal.textContent = '—––°';
    refs.headSrc.textContent = 'compas inactif';
    refs.headExtra.textContent = '';
    return;
  }
  widgets.compass.set(hd.deg, marks, hd.quality);

  const txt = fmt.heading(hd.deg);
  if (refs.headVal.textContent !== txt) refs.headVal.textContent = txt;

  const src =
    hd.source === 'compass' ? `compas · ${qualityLabel(hd.quality)}`
    : hd.source === 'cog' ? 'route fond GPS'
    : 'compas figé';
  if (refs.headSrc.textContent !== src) refs.headSrc.textContent = src;

  const extra = hd.deviation
    ? `déviation ${hd.deviation > 0 ? '+' : ''}${hd.deviation}° / route`
    : hd.tilted ? 'pose ambiguë — redresse ou pose à plat'
    : `mag ${fmt.heading(hd.magnetic ?? hd.deg)}`;
  if (refs.headExtra.textContent !== extra) refs.headExtra.textContent = extra;
}

/** Recalcule les relèvements du cadran. Position et courant : rythme du GPS. */
function computeMarks(now, fix, pos) {
  const out = [];
  if (state.waypoint && fix) {
    out.push({ deg: bearing(fix, state.waypoint), color: '#a3e635', label: 'WPT' });
  }
  if (state.mob && fix) {
    out.push({ deg: bearing(fix, state.mob), color: '#fb5a72', label: 'MOB' });
  }
  const st = stream.tidalStream(now, pos);
  out.push({ deg: st.dir, color: st.sense === 'ebb' ? '#fb923c' : '#22d3ee', label: 'CRT' });
  marks = out;
}

/**
 * Ce qui bouge au rythme du GPS : vitesse fond, relèvements, veilles. Assez
 * léger pour tourner à chaque fix, trop dépendant de la position pour attendre
 * le rendu complet des 5 secondes.
 */
function renderKinetics() {
  const now = Date.now();
  const fix = state.fix;
  if (!refs.speedLbl) return;

  widgets.speed.set(fix?.speedKn ?? null);
  refs.speedQual.textContent = fix ? `±${Math.round(fix.accuracy || 0)} m` : 'sans position';

  computeMarks(now, fix, fix ? { lat: fix.lat, lon: fix.lon } : spots.getPort());
  renderHeading();
  renderWatches(now, fix);
}

/** Sortie en cours, alerte mouillage, route sur waypoint. */
function renderWatches(now, fix) {
  const parts = [];
  if (state.trip) {
    parts.push(`Sortie : ${fmt.dist(state.trip.distanceM)} · ${fmt.duration(now - state.trip.startedAt)} · max ${fmt.num(state.trip.maxSpeedKn, 1)} nd`);
  }
  if (state.anchor?.armed && fix) {
    parts.push(`Alerte mouillage : ${Math.round(distance(state.anchor, fix))} m du point / rayon ${state.anchor.radiusM} m`);
  }
  if (state.waypoint && fix) {
    const d = distance(fix, state.waypoint);
    const b = bearing(fix, state.waypoint);
    const eta = fix.speedKn > 0.5 ? fmt.duration((d / 1852 / fix.speedKn) * HOUR) : '—';
    parts.push(`→ ${state.waypoint.name} : ${fmt.dist(d)} au ${fmt.heading(b)} · ETA ${eta}`);
  }
  const txt = parts.join('\n') || 'Aucune veille active.';
  if (refs.tripInfo.textContent !== txt) refs.tripInfo.textContent = txt;
}

function render() {
  const now = Date.now();
  const fix = state.fix;
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const pos = fix ? { lat: fix.lat, lon: fix.lon } : spots.getPort();

  /* ---- Jauges ---------------------------------------------------------- */
  widgets.speed.set(fix?.speedKn ?? null);
  refs.speedQual.textContent = fix ? `±${Math.round(fix.accuracy || 0)} m` : 'sans position';

  widgets.wind.set(wx?.windSpeedKn ?? null, wx ? fmt.cardinal(wx.windDirDeg) : '');
  // Sous la jauge, la place existe : le secteur s'y écrit en toutes lettres.
  // « NO » demande de connaître la rose ; « vent de nord-ouest », non.
  refs.windQual.textContent = wx
    ? `${fmt.windFrom(wx.windDirDeg)} · F${fmt.beaufort(wx.windSpeedKn)}${
        wx.windGustKn > wx.windSpeedKn + 4 ? ` · raf ${Math.round(wx.windGustKn)}` : ''
      }`
    : 'indisponible';

  /* ---- Compas ---------------------------------------------------------- */
  const hd = state.heading;
  const st = stream.tidalStream(now, pos);
  computeMarks(now, fix, pos);
  renderHeading();

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
  // Le résiduel océanique vient d'un modèle global à 8 km de maille, dont on ne
  // sait pas s'il contient déjà la marée. Il est plafonné, et affiché à part :
  // une composante qu'on ne peut pas vérifier n'a rien à faire fondue dans un
  // total où plus personne ne la voit passer.
  if (drift.residual && drift.residual.spd > 0.05) {
    ci.append(kv('dont résiduel', `${fmt.num(drift.residual.spd, 1)} nd (modèle global)`));
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
  refs.btnAnchor.textContent = state.anchor?.armed ? '⚓ Lever l’alerte' : '⚓ Alerte mouillage';
  refs.btnAnchor.className = `btn ${state.anchor?.armed ? 'btn-lime' : ''}`;
  refs.btnTrip.textContent = state.trip ? '⏹ Fin de sortie' : '▶︎ Sortie';
  refs.btnTrip.className = `btn ${state.trip ? 'btn-lime' : ''}`;

  renderWatches(now, fix);
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
 * Diagnostic du compas
 * ========================================================================== */

/**
 * Tout ce qui permet de dire POURQUOI le cap va mal, sans rien inventer.
 * Rafraîchi en direct : c'est en tournant le téléphone pendant que l'écran est
 * ouvert qu'on voit si le retard vient du capteur ou de l'affichage.
 */
function openCompassDiag() {
  const body = el('div');
  const grid = el('div');
  body.append(grid);

  const note = el('p', 'tiny',
    'Tourne le téléphone lentement pendant que cet écran est ouvert. Si « brut » ' +
    'suit ton geste et que « cadence » reste au-dessus de 20 Hz, le capteur va ' +
    'bien. Si la cadence est basse ou nulle, c’est l’autorisation ou l’appareil.');
  body.append(note);

  const help = el('div', 'tiny');
  help.style.marginTop = '8px';
  body.append(help);

  const btn = button('Redemander l’autorisation', 'btn-lg', async () => {
    const res = await compass.requestPermission();
    toast(`Autorisation : ${res}`, res === 'granted' ? 'good' : 'warn');
  });
  body.append(btn);

  // Rapporter un compas qui déraille ne doit pas obliger à recopier vingt
  // lignes à la main ni à cadrer une capture d'écran d'une main sur un pont
  // qui bouge.
  body.append(button('📋 Copier le diagnostic', 'btn-sm', async () => {
    const d = compass.diagnostics();
    const txt = [
      `Grim's Compagnon ${APP_VERSION} — diagnostic compas`,
      new Date().toISOString(),
      navigator.userAgent,
      '',
      ...Object.entries({
        supporté: d.supported, autorisation: d.permission, écoute: d.listening,
        mesures: d.events, ignorés: d.ignored, cadence_Hz: d.rateHz.toFixed(1),
        âge_ms: d.ageMs, source: d.lockedType, champ: d.field, absolu: d.absolute,
        alpha: d.alpha, beta: d.beta, gamma: d.gamma,
        correction_assiette: d.tiltFix, accord_axes: d.axisQuality,
        brut: d.raw, filtré: d.filtered,
        cap_affiché: state.heading?.deg, origine: state.heading?.source,
        bruit: state.heading?.spread,
      }).map(([k, v]) => `${k}: ${v}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      toast('Diagnostic copié — colle-le dans un message', 'good');
    } catch {
      toast('Copie refusée par le navigateur');
    }
  }));

  const line = (k, v) => {
    const r = el('div', 'row');
    r.style.justifyContent = 'space-between';
    r.style.padding = '3px 0';
    r.append(el('span', 'tiny', k), el('span', 'tnum', v));
    r.lastChild.style.fontSize = '13px';
    r.lastChild.style.fontWeight = '650';
    return r;
  };

  const paint = () => {
    const d = compass.diagnostics();
    const hd = state.heading;
    clear(grid);
    grid.append(line('Version', APP_VERSION));
    grid.append(line('Compas disponible', d.supported ? 'oui' : 'NON'));
    grid.append(line('Autorisation', d.permission));
    grid.append(line('Écoute active', d.listening ? 'oui' : 'NON'));
    grid.append(line('Mesures reçues', String(d.events)));
    grid.append(line('Cadence', d.events ? `${d.rateHz.toFixed(1)} Hz` : '—'));
    grid.append(line('Âge dernière mesure', d.ageMs == null ? '—' : `${d.ageMs} ms`));
    grid.append(line('Source retenue', d.lockedType));
    grid.append(line('Champ utilisé', d.field || '—'));
    grid.append(line('Référence absolue', d.absolute === null ? 'non annoncée' : String(d.absolute)));
    grid.append(line('Flux ignorés', String(d.ignored)));
    grid.append(line('Cap brut (mag)', d.raw == null ? '—' : `${d.raw.toFixed(1)}°`));
    grid.append(line('Cap filtré (mag)', d.filtered == null ? '—' : `${d.filtered.toFixed(1)}°`));
    grid.append(line('Retard du filtre', d.raw == null || d.filtered == null
      ? '—' : `${Math.abs(angleDiff(d.raw, d.filtered)).toFixed(1)}°`));
    grid.append(line('Cap affiché (vrai)', hd ? fmt.heading(hd.deg) : '—'));
    grid.append(line('Origine du cap', hd?.source || '—'));
    grid.append(line('Bruit du capteur', hd?.spread == null ? '—' : `${hd.spread.toFixed(1)}°`));
    grid.append(line('Précision annoncée', d.accuracy == null ? 'non fournie' : `${d.accuracy}°`));
    grid.append(line('Assiette (β / γ)', d.beta == null ? '—'
      : `${Math.round(d.beta)}° / ${Math.round(d.gamma ?? 0)}°`));
    grid.append(line('Correction d’assiette', `${d.tiltFix > 0 ? '+' : ''}${(d.tiltFix ?? 0).toFixed(1)}°`));
    grid.append(line('Accord des axes', `${Math.round((d.axisQuality ?? 1) * 100)} %`));

    help.textContent =
      !d.supported ? 'Cet appareil n’expose pas d’orientation : le cap restera la route fond GPS.'
      : d.events === 0 && d.needsPermission ? 'Aucune mesure et une autorisation à donner : appuie sur le bouton ci-dessous, c’est le cas le plus fréquent sur iPhone.'
      : d.events === 0 ? 'Aucune mesure reçue alors que l’autorisation ne semble pas en cause. Le magnétomètre est peut-être désactivé dans les réglages du téléphone.'
      : d.rateHz > 0 && d.rateHz < 8 ? 'Le capteur émet très peu souvent : le retard vient de lui, pas de l’affichage.'
      : d.ignored > d.events ? 'Beaucoup de flux écartés : deux sources d’orientation se contredisent, seule la plus fiable est gardée.'
      : 'Le capteur alimente correctement l’affichage.';
    btn.hidden = !d.needsPermission;
  };

  paint();
  const iv = setInterval(paint, 250);
  openSheet('Diagnostic compas', body, () => clearInterval(iv));
}

/* ==========================================================================
 * Actions
 * ========================================================================== */

function toggleAnchor() {
  if (state.anchor?.armed) {
    gps.weighAnchor();
    toast('Alerte mouillage levée');
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
    toast('Alerte mouillage armée', 'good');
    document.getElementById('sheet-backdrop').hidden = true;
  }));
  openSheet('Alerte mouillage', body);
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
  ({ good: 'stable', fair: 'moyen', poor: 'bruité', bad: 'pose ambiguë', stale: 'figé' }[q] || q);

function coefClass(c) {
  if (c >= 95) return 'c-red';
  if (c >= 70) return 'c-lime';
  if (c >= 45) return 'c-cyan';
  return 'c-dim';
}

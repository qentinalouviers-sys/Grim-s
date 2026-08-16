/* ==========================================================================
 * views/nav.js — la CABINE
 * --------------------------------------------------------------------------
 * L'écran d'avant la sortie, et celui du retour au mouillage. On y décide :
 * où l'on va, quand, et si ça vaut le coup. On n'y barre pas — barrer a son
 * mode, avec son compas et sa vitesse en gros ; les remettre ici en faisait
 * un double emploi qui volait le haut de l'écran à ce qu'on venait lire.
 *
 * Hiérarchie assumée, de haut en bas :
 *   1. OÙ — le port choisi, changeable d'un toucher
 *   2. le temps qu'il fait là-bas, mer comprise
 *   3. la marée, le courant, la journée
 *   4. le conseil du guide
 *   5. les commandes : les deux modes, le but, la veille, le retour
 *
 * ── LE PORT ET LA MARÉE NE VIENNENT PAS DU MÊME ENDROIT ───────────────────
 * La météo et l'état de la mer se calculent partout : changer de port les
 * change vraiment. La marée, non — le modèle harmonique est ajusté sur
 * Dieppe. L'écran le dit dès que le port choisi s'en éloigne trop, au lieu
 * d'afficher une heure de pleine mer qui aurait l'air juste et serait fausse.
 * ========================================================================== */

import { state, subscribe, emit } from '../core/store.js';
import { el, pill, button, toast, openSheet, closeSheet, clear } from '../ui/dom.js';
import { TideChart, StreamProfile, CurrentRose } from '../ui/widgets.js';
import * as fmt from '../core/fmt.js';
import { bearing, distance, angleDiff } from '../core/geo.js';
import * as tide from '../data/tide.js';
import * as stream from '../data/stream.js';
import * as weather from '../data/weather.js';
import * as gps from '../sensors/gps.js';
import * as spots from '../fishing/spots.js';
import * as route from '../nav/route.js';
import { openDestinationPicker } from '../ui/destination.js';
import { openForecast } from '../ui/forecast.js';
import { openDriveChooser, helmIcon } from './drive.js';
import { openFishChooser } from './fishmode.js';
import * as places from '../data/places.js';
import * as anchorwatch from '../core/anchorwatch.js';
import { sunTimes, moonPhase } from '../data/astro.js';

const HOUR = 3600000;

let root;
let unsubs = [];
let widgets = {};
let refs = {};
let timer = 0;

export function mount(container) {
  root = clear(container);

  /* ---- Où l'on est, ou plutôt où l'on VA -------------------------------
   * Tout en haut, et cliquable : le port commande la météo, la mer et les
   * conseils de tout l'écran. Il doit se voir sans chercher et se changer
   * sans fouiller. */
  refs.place = el('button', 'card place-card');
  refs.place.type = 'button';
  refs.place.addEventListener('click', openPlacePicker);
  root.append(refs.place);

  /* ---- Le temps qu'il fait là-bas ---------------------------------------
   * Deux services gratuits superposés, et ils ne disent pas la même chose :
   * la prévision atmosphérique donne le vent, les rafales, la pression et la
   * visibilité ; la prévision marine donne la houle, sa période et sa
   * direction, plus la température de l'eau. Un pêcheur a besoin des deux —
   * un vent de dix nœuds sur une houle d'un mètre cinquante de sud-ouest,
   * c'est une sortie annulée, et le vent seul ne le dit pas. */
  refs.wx = el('div', 'card');
  root.append(refs.wx);

  /* ---- Actions ---------------------------------------------------------
   * Construites ici mais POSÉES PLUS BAS, après la marée et le courant : c'est
   * l'ordre demandé, et il se défend. La cabine est l'écran d'AVANT la sortie —
   * on y lit d'abord, on décide ensuite, et on n'appuie sur « mode navigation »
   * qu'une fois qu'on a regardé le vent et l'heure de la basse mer. Les
   * commandes qui comptent en mer, elles, ne sont plus ici : elles sont dans
   * les modes isolés, à un seul toucher de distance. */
  const actions = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'ACTIONS'));
  actions.append(head);

  // La navigation GPS est l'action la plus lourde de conséquences de cet
  // écran : elle occupe toute la largeur, seule, et se lit sans chercher.
  /* Le mode navigation passe DEVANT « Naviguer vers… », et ce n'est pas une
   * promotion arbitraire : « naviguer vers » demande déjà de savoir où l'on
   * va, alors que la plupart des sorties commencent sans but — on largue les
   * amarres, on verra sur l'eau. Le mode conduite accepte les deux, et c'est
   * lui qui pose la question. */
  refs.btnDrive = button('Mode navigation', 'btn-primary btn-lg', openDriveChooser);
  refs.btnDrive.prepend(helmIcon(21));
  actions.append(refs.btnDrive);

  refs.btnFish = button('🎣 Mode pêche', 'btn-lg act-fish', openFishChooser);
  refs.btnFish.style.marginTop = '8px';
  actions.append(refs.btnFish);

  refs.btnGo = button('🎯 Naviguer vers…', 'btn-lg', () => openDestinationPicker());
  refs.btnGo.style.marginTop = '8px';
  actions.append(refs.btnGo);

  const row1 = el('div', 'btn-row');
  row1.style.marginTop = '8px';
  refs.btnAnchor = button('⚓ Alerte mouillage', '', toggleAnchor);
  refs.btnHome = button('🏠 Retour au port', '', () => {
    const p = spots.getPort();
    route.start({ lat: p.lat, lon: p.lon, name: p.name, kind: 'port' });
  });
  row1.append(refs.btnAnchor, refs.btnHome);

  const row2 = el('div', 'btn-row');
  row2.style.marginTop = '8px';
  refs.btnTrip = button('▶︎ Sortie', '', toggleTrip);
  refs.btnDrift = button('⏱ Relever dérive', '', () => emit('drift:record'));
  row2.append(refs.btnTrip, refs.btnDrift);

  actions.append(row1, row2);
  refs.tripInfo = el('div', 'tiny');
  refs.tripInfo.style.marginTop = '8px';
  actions.append(refs.tripInfo);

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

  /* Les commandes, après la lecture. */
  root.append(actions);

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
  /* Plus d'abonnement au compas : il n'y a plus de compas ici. Le magnétomètre
     parle jusqu'à soixante fois par seconde et cet écran n'a rien qui change à
     cette cadence — l'y brancher faisait redessiner la page pour rien. */
  unsubs.push(subscribe('fix', renderKinetics));              // 1 Hz
  unsubs.push(subscribe(
    ['tide', 'weather', 'trip', 'anchor', 'waypoint', 'advice', 'motion'],
    render,
  ));
  timer = setInterval(render, 5000);
  render();
}

/**
 * Redessin sur demande de l'orchestrateur — un changement de port, un retour
 * sur l'onglet. Gardé contre l'appel hors montage : l'événement « port changé »
 * part aussi quand la cabine n'est pas à l'écran.
 */
export function refresh() {
  if (refs.place) render();
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

/* --------------------------------------------------------------------------
 * Le port choisi
 * ------------------------------------------------------------------------ */
function renderPlace(place, fix) {
  const box = clear(refs.place);
  const main = el('div', 'place-main');
  main.append(el('div', 'place-name', place ? place.name : 'Choisir un port'));
  const sub = [];
  if (place?.region) sub.push(place.region);
  if (fix) sub.push(`GPS à ${fmt.dist(distance(fix, place || spots.getPort()))}`);
  main.append(el('div', 'place-sub', sub.join(' · ') || 'touche pour choisir'));
  box.append(main);
  box.append(el('span', 'place-change', 'CHANGER'));
}

/* --------------------------------------------------------------------------
 * Météo et état de la mer
 * --------------------------------------------------------------------------
 * Deux services superposés. On ne les mélange pas dans une moyenne : chaque
 * ligne dit ce qu'elle mesure, et ce qui manque manque visiblement plutôt que
 * d'être remplacé par un zéro.
 * ------------------------------------------------------------------------ */
function renderWeather(wx, place) {
  const box = clear(refs.wx);
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'MÉTÉO CÔTIÈRE'), el('div', 'spacer'));
  const src = el('span', 'chip', state.weather?.stale
    ? `datée de ${fmt.age(state.weather.fetchedAt)}` : 'à jour');
  if (state.weather?.stale) src.classList.add('warn');
  head.append(src);
  box.append(head);

  if (!wx) {
    box.append(el('p', 'muted', 'Prévision indisponible — pas encore de réseau depuis l’ouverture. Le reste de l’écran, marée et courant compris, est calculé à bord et reste juste.'));
    return;
  }

  const bf = fmt.beaufort(wx.windSpeedKn);
  const wind = el('div', 'wx-hero');
  wind.append(el('div', 'wx-hero-v tnum', `${Math.round(wx.windSpeedKn)}`));
  const wu = el('div');
  wu.append(el('div', 'wx-hero-u', 'NŒUDS'), el('div', 'wx-hero-f', `Force ${bf} · ${fmt.beaufortLabel(bf)}`));
  wind.append(wu);
  box.append(wind);
  box.append(el('div', 'wx-from', `${fmt.windFrom(wx.windDirDeg)}${
    wx.windGustKn > wx.windSpeedKn + 4 ? ` · rafales ${Math.round(wx.windGustKn)} nd` : ''}`));

  const grid = el('div', 'wx-grid');
  const cell = (v, l, title) => {
    const c = el('div', 'wx-cell');
    if (title) c.title = title;
    c.append(el('div', 'wx-cell-v tnum', v), el('div', 'wx-cell-l', l));
    grid.append(c);
  };
  // Les noms viennent de weather.js, vérifiés dans le module : une case
  // nourrie d'un champ qui n'existe pas ne s'affiche pas — elle affiche « — »,
  // ce qui ressemble à une donnée manquante alors que c'est une faute de
  // frappe. Ici, chaque champ a été lu à la source.
  // « MER » seul : c'est la hauteur significative, houle et clapot combinés —
  // le chiffre qui décide de la sortie. Le libellé long tenait sur deux lignes
  // à 320 px ; le sens complet est dans l'infobulle.
  if (wx.waveHeightM != null) {
    cell(`${fmt.num(wx.waveHeightM, 1)} m`, 'MER', 'Mer totale — hauteur significative, houle et clapot combinés');
  }
  if (wx.wavePeriodS != null) cell(`${Math.round(wx.wavePeriodS)} s`, 'PÉRIODE');
  if (wx.waveDirDeg != null) cell(fmt.cardinal(wx.waveDirDeg), 'VENANT DE');
  if (wx.swellHeightM != null) cell(`${fmt.num(wx.swellHeightM, 1)} m`, 'HOULE');
  /* « CLAPOT » et non « MER DU VENT » : c'est le mot qu'emploient les pêcheurs
   * de la Manche pour cette mer courte levée par le vent du moment, et il tient
   * sur une ligne dans une case de 88 px — la version longue passait à deux
   * lignes sur un iPhone SE, seule de la grille. Le terme complet reste dans
   * l'infobulle. */
  if (wx.windWaveHeightM != null) {
    cell(`${fmt.num(wx.windWaveHeightM, 1)} m`, 'CLAPOT', 'Mer du vent — vagues levées par le vent local');
  }
  if (wx.seaTempC != null) cell(`${fmt.num(wx.seaTempC, 1)}°`, 'EAU');
  if (wx.airTempC != null) cell(`${Math.round(wx.airTempC)}°`, 'AIR');
  if (wx.pressureHpa != null) cell(Math.round(wx.pressureHpa), 'hPa');
  /* La visibilité se lit en kilomètres, pas en milles : c'est l'unité de tous
   * les bulletins météo, et « 7.67 NM » oblige à convertir de tête pour savoir
   * si l'on voit la falaise. Sous dix kilomètres on garde une décimale — c'est
   * là que la différence entre 2 et 3 km change la décision de sortir. */
  if (wx.visibilityM != null) {
    const km = wx.visibilityM / 1000;
    cell(km < 1 ? `${Math.round(wx.visibilityM)} m` : `${fmt.num(km, km < 10 ? 1 : 0)} km`, 'VISIBILITÉ');
  }
  if (wx.cloudPct != null) cell(`${Math.round(wx.cloudPct)} %`, 'NUAGES');
  box.append(grid);

  /* ---- La semaine -------------------------------------------------------
   * Sept jours résumés à une ligne chacun, directement sur la carte : c'est ce
   * qu'on regarde en premier quand on choisit QUAND sortir, et le mettre
   * derrière un bouton aurait obligé à ouvrir une fenêtre pour apprendre que
   * jeudi souffle à trente. Le détail heure par heure, lui, mérite l'écran
   * entier — il s'ouvre d'un toucher sur le jour. */
  const days = weather.byDay(state.weather?.hourly || []);
  if (days.length > 1) {
    const week = el('div', 'wx-week');
    const now = Date.now();
    days.forEach((d, i) => {
      const conf = weather.confidence(d.start, now);
      const row = el('button', `wx-day${conf.level === 'low' ? ' far' : ''}`);
      row.type = 'button';
      row.append(el('span', 'wx-day-n', dayName(d.start, now)));

      const s = d.summary;
      const w = el('span', 'wx-day-w tnum');
      w.textContent = s.windMaxKn == null ? '—'
        : `${Math.round(s.windMinKn)}–${Math.round(s.windMaxKn)} nd`;
      w.style.color = windColor(s.windMaxKn);
      row.append(w);

      row.append(el('span', 'wx-day-c', s.windDirDeg == null ? '' : fmt.cardinal(s.windDirDeg)));
      row.append(el('span', 'wx-day-s tnum',
        s.waveMaxM == null ? '' : `🌊 ${fmt.num(s.waveMaxM, 1)} m`));
      row.append(el('span', 'chev', '›'));
      row.addEventListener('click', () => openForecast({ hourly: state.weather.hourly, place, dayIndex: i }));
      week.append(row);
    });
    box.append(week);

    const more = button('📅 Heure par heure · 7 jours', 'btn-sm',
      () => openForecast({ hourly: state.weather.hourly, place, dayIndex: 0 }));
    more.style.marginTop = '8px';
    more.style.width = '100%';
    box.append(more);
  }

  box.append(el('div', 'tiny',
    `Pour ${place ? place.name : 'la position'} · vent, pression et visibilité : Open-Meteo. Mer, houle et température de l’eau : Open-Meteo Marine. Deux modèles distincts, affichés séparément.`));
}

/** « Auj. », « Demain », puis « mer. 19 » — comme on en parle à bord. */
function dayName(t, now) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(t).setHours(0, 0, 0, 0) - d0.getTime()) / 86400000);
  if (diff === 0) return "Auj.";
  if (diff === 1) return 'Demain';
  const d = new Date(t);
  return `${['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][d.getDay()]} ${d.getDate()}`;
}

/* Les seuils sont ceux d'un petit bateau de pêche : au-delà de force 6, une
 * embarcation de six mètres n'avance plus, elle encaisse. La couleur le dit
 * avant qu'on ait lu le chiffre. */
function windColor(kn) {
  if (kn == null) return 'var(--txt-2)';
  if (kn < 11) return 'var(--lime)';
  if (kn < 17) return 'var(--amber)';
  if (kn < 22) return '#fb923c';
  return 'var(--red)';
}

/**
 * Ce qui bouge au rythme du GPS : vitesse fond, relèvements, veilles. Assez
 * léger pour tourner à chaque fix, trop dépendant de la position pour attendre
 * le rendu complet des 5 secondes.
 */
function renderKinetics() {
  if (!refs.tripInfo) return;
  renderWatches(Date.now(), state.fix);
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
  /* Le port choisi commande l'écran, SAUF si le GPS a un point : en mer, ce
     qui compte est là où l'on est, pas là où l'on comptait aller. */
  const place = places.current();
  const pos = fix ? { lat: fix.lat, lon: fix.lon } : (place || spots.getPort());

  renderPlace(place, fix);
  renderWeather(wx, place);

  const hd = state.heading;
  const st = stream.tidalStream(now, pos);

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
 * Actions
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * Alerte mouillage
 * --------------------------------------------------------------------------
 * Elle passe par `anchorwatch` et non plus par le seul module GPS : la veille
 * doit survivre au changement d'écran, au redémarrage de l'app, et prévenir
 * par une notification système. Ce que le navigateur ne permet PAS est écrit
 * dans la feuille, avant d'armer — une fausse sécurité au mouillage finit sur
 * les cailloux.
 * ------------------------------------------------------------------------ */
async function toggleAnchor() {
  if (state.anchor?.armed) {
    await anchorwatch.disarm();
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

  /* Ce qu'elle fait, et ce qu'elle ne fait pas. Dit AVANT d'armer, pas dans
     une page d'aide que personne n'ouvre au mouillage. */
  const note = el('div', 'banner info');
  note.append(el('span', null,
    'Tant que la veille est armée, l’écran reste allumé : c’est ce qui permet au GPS de continuer. '
    + 'Une app web ne peut pas surveiller la position téléphone verrouillé et app fermée — le navigateur suspend tout. '
    + 'Garde le téléphone allumé et branché.'));
  body.append(note);

  const perm = anchorwatch.notificationState();
  if (perm === 'denied') {
    const warn = el('div', 'banner warn');
    warn.append(el('span', null, 'Les notifications sont refusées pour cette app : l’alarme sonnera et vibrera, mais rien ne s’affichera par-dessus les autres applications. Ça se réactive dans les réglages du navigateur.'));
    body.append(warn);
  }

  body.append(button('Armer la veille', 'btn-primary btn-lg', async () => {
    const r = Math.max(15, Math.min(300, Number(input.value) || 50));
    await anchorwatch.arm(r);
    closeSheet();
    toast(
      anchorwatch.notificationState() === 'granted'
        ? `Veille armée · rayon ${r} m · notification active`
        : `Veille armée · rayon ${r} m`,
      'good',
    );
    render();
  }));
  openSheet('Alerte mouillage', body);
}

/* --------------------------------------------------------------------------
 * Choisir son port
 * --------------------------------------------------------------------------
 * La liste embarquée répond dès la première lettre, sans réseau. La recherche
 * en ligne arrive derrière, quand elle arrive, et complète — elle ne remplace
 * jamais ce qui est déjà à l'écran.
 * ------------------------------------------------------------------------ */
function openPlacePicker() {
  const body = el('div');
  const field = el('div', 'field');
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Port ou ville — Fécamp, Saint-Vaast, Boulogne…';
  input.autocapitalize = 'words';
  input.autocomplete = 'off';
  field.append(input);
  body.append(field);

  const list = el('div', 'card flush');
  body.append(list);
  const note = el('div', 'tiny');
  body.append(note);

  let token = 0;
  const paint = (rows, extra) => {
    clear(list);
    if (!rows.length) {
      list.append(el('div', 'empty', 'Aucun port sous ce nom. Essaie la ville la plus proche.'));
      return;
    }
    for (const r of rows) {
      const row = el('button', 'list-item');
      row.type = 'button';
      const main = el('div', 'list-main');
      main.append(el('div', 'list-title', r.name));
      const v = places.tideValidity(r);
      main.append(el('div', 'list-sub',
        `${r.region || ''}${r.region ? ' · ' : ''}${v.ok ? 'marée de Dieppe applicable' : 'marée non valable ici'}`));
      row.append(main, el('span', 'chev', '›'));
      row.addEventListener('click', async () => {
        // closeSheet et non backdrop.hidden : la pile de feuilles se vide et
        // les fonctions de fermeture tournent. Masquer le fond laissait une
        // feuille fantôme dans la pile, et le retour d'une feuille ouverte
        // ensuite revenait sur celle-ci.
        closeSheet();
        // `choose` annonce elle-même le changement : l'orchestrateur relance la
        // météo et redemande le rendu. Émettre ici en plus doublait le tour.
        await places.choose(r);
        toast(`Port : ${r.name}`, 'good');
        render();
      });
      list.append(row);
    }
    note.textContent = extra || '';
  };

  const run = async () => {
    const q = input.value;
    const local = places.searchLocal(q);
    paint(local, local.length ? 'Ports embarqués — disponibles sans réseau.' : '');
    const mine = ++token;
    const remote = await places.searchRemote(q);
    // Une réponse réseau qui arrive après qu'on a retapé ne doit pas écraser
    // la recherche en cours : c'est la course classique de l'autocomplétion.
    if (mine !== token || !remote.length) return;
    paint(places.merge(local, remote), 'Ports embarqués, puis résultats en ligne.');
  };

  input.addEventListener('input', run);
  run();
  openSheet('Choisir le port', body);
  setTimeout(() => input.focus(), 80);
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

function coefClass(c) {
  if (c >= 95) return 'c-red';
  if (c >= 70) return 'c-lime';
  if (c >= 45) return 'c-cyan';
  return 'c-dim';
}

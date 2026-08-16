/* ==========================================================================
 * fishing/record.js — enregistrer une prise en un geste
 * --------------------------------------------------------------------------
 * Le geste de saisie est le point faible de tous les carnets de pêche : on a
 * un poisson dans une main, la canne dans l'autre, le bateau bouge, et
 * remplir un formulaire à six champs ne se fait pas. Résultat : on ne note
 * rien, et le journal — donc l'apprentissage — reste vide.
 *
 * Ici : bouton flottant → une grille d'espèces → UN tap et c'est enregistré.
 * Tout le reste est capturé automatiquement.
 *
 * ── CE QUI EST CAPTURÉ SANS RIEN DEMANDER ─────────────────────────────────
 * Position GPS et sa précision, poste le plus proche, hauteur d'eau, coefficient,
 * sens et phase de marée, heures depuis la PM et la BM, prochaine étale,
 * courant et dérive, vent et rafales, pression et sa tendance 6 h, température
 * de l'eau, mer, visibilité, turbidité estimée, phase de lumière, hauteur du
 * soleil, lune, état de mer ressenti sous la coque, cap et vitesse du bateau,
 * et le score que le modèle prédisait à cet instant.
 *
 * Ce dernier point est ce qui transforme un carnet en boucle d'apprentissage :
 * sans le score prédit, on ne peut jamais savoir si le modèle avait raison.
 *
 * ── TRAÇABILITÉ ───────────────────────────────────────────────────────────
 * Le snapshot enregistre AUSSI la provenance de la marée (SHOM / harmonique /
 * provisoire) et l'âge de la météo. Une prise notée sur un modèle de marée non
 * calé ne vaut pas une prise notée sur la donnée officielle, et il faut
 * pouvoir le savoir trois mois plus tard.
 * ========================================================================== */

import { state, emit } from '../core/store.js';
import * as idb from '../core/idb.js';
import { el, button, toast, openSheet, closeSheet } from '../ui/dom.js';
import * as fmt from '../core/fmt.js';
import { distance, bearing } from '../core/geo.js';
import { SPECIES_RULES, SPECIES_ORDER, OTHER_SPECIES, getRegulationStatus } from './species.js';
import * as catalog from './catalog.js';
import { openSpeciesBook } from '../ui/speciesbook.js';
import * as spots from './spots.js';
import * as tide from '../data/tide.js';
import * as stream from '../data/stream.js';
import * as seabed from '../data/seabed.js';
import * as weather from '../data/weather.js';
import { sunTimesOfDay, sunAltitude, moonPhase, lightPhaseAt } from '../data/astro.js';
import * as learning from './learning.js';

const HOUR = 3600000;

/* ==========================================================================
 * Espèces libres
 * --------------------------------------------------------------------------
 * Une espèce saisie à la main est mémorisée : la fois d'après elle apparaît
 * dans la grille, à un tap comme les autres. Sinon on la retape à chaque
 * sortie et on finit par ne plus la noter.
 * ========================================================================== */

let customSpecies = [];

export async function initRecord() {
  customSpecies = (await idb.get('kv', 'customSpecies')) || [];
  return customSpecies.length;
}

export const getCustomSpecies = () => [...customSpecies];

async function rememberCustom(name) {
  const clean = name.trim().slice(0, 40);
  if (!clean) return null;
  // Identifiant stable : « Vieille » et « vieille » ne doivent pas créer deux
  // entrées. On retire les diacritiques combinants (U+0300–U+036F) après NFD.
  const id = `x-${clean.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  if (!customSpecies.some((c) => c.id === id)) {
    customSpecies.unshift({ id, name: clean, emoji: '🎣', color: '#e8f1fa', custom: true });
    customSpecies = customSpecies.slice(0, 20);
    await idb.put('kv', 'customSpecies', customSpecies);
    await idb.put('kv', 'customSpeciesAt', Date.now());
  }
  return { id, name: clean };
}

export async function forgetCustom(id) {
  customSpecies = customSpecies.filter((c) => c.id !== id);
  await idb.put('kv', 'customSpecies', customSpecies);
  await idb.put('kv', 'customSpeciesAt', Date.now());
}

/** Descripteur d'affichage d'une espèce, connue ou libre. */
export function speciesInfo(id, fallbackName = null) {
  if (SPECIES_RULES[id]) {
    const r = SPECIES_RULES[id];
    return { id, name: r.name, emoji: r.emoji, color: r.color, custom: false };
  }
  // Le catalogue prend le relais : une prise enregistrée depuis une fiche garde
  // son nom, sa couleur et son emoji partout — carte, journal, export GPX.
  const cat = catalog.findSpecies(id);
  if (cat) return { id, name: cat.name, emoji: cat.emoji, color: cat.color, custom: false };

  const c = customSpecies.find((x) => x.id === id);
  if (c) return { ...c, custom: true };
  return {
    id: id || 'autre',
    name: fallbackName || OTHER_SPECIES.name,
    emoji: OTHER_SPECIES.emoji,
    color: OTHER_SPECIES.color,
    custom: true,
  };
}

/* ==========================================================================
 * Le snapshot
 * ========================================================================== */

/**
 * Photographie complète de l'instant. Purement local : fonctionne hors réseau,
 * ce qui est le cas normal au moment où on sort un poisson.
 */
export function buildSnapshot(t = Date.now(), speciesId = null) {
  const fix = state.fix;
  const pos = fix ? { lat: fix.lat, lon: fix.lon } : spots.getPort();
  const hourly = state.weather?.hourly || [];
  const wx = hourly.length ? weather.interp(hourly, t) : null;

  /* --- Marée ---------------------------------------------------------- */
  const info = tide.info(t);
  const ext = tide.extrema(t - 14 * HOUR, t + 14 * HOUR);
  const lastHW = [...ext].reverse().find((e) => e.kind === 'HW' && e.t <= t);
  const nextHW = ext.find((e) => e.kind === 'HW' && e.t > t);
  const lastLW = [...ext].reverse().find((e) => e.kind === 'LW' && e.t <= t);
  const nextLW = ext.find((e) => e.kind === 'LW' && e.t > t);
  const nearestOf = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  };
  const refHW = nearestOf(lastHW, nextHW);
  const refLW = nearestOf(lastLW, nextLW);

  /* --- Courant --------------------------------------------------------- */
  const drift = stream.driftVector(t, pos, wx);
  const cfg = stream.config();

  /* --- Astro ----------------------------------------------------------- */
  // Le soleil du JOUR de la prise : une prise notée à 05 h se voyait sinon
  // attribuer le lever et le coucher de la veille.
  const sun = sunTimesOfDay(t, pos.lat, pos.lon);
  const moon = moonPhase(new Date(t));

  /* --- Poste le plus proche -------------------------------------------- */
  let nearestSpot = null;
  if (fix) {
    let best = null;
    for (const s of spots.all()) {
      const d = distance(pos, s);
      if (!best || d < best.d) best = { s, d };
    }
    if (best && best.d < 4000) {
      nearestSpot = {
        id: best.s.id,
        name: best.s.name,
        distanceM: Math.round(best.d),
        bearingDeg: Math.round(bearing(pos, best.s)),
        seed: !!best.s.seed,
        depthM: best.s.depthM || null,
      };
    }
  }

  /* --- Ce que le modèle prédisait --------------------------------------- */
  let predicted = null;
  if (speciesId && state.scores?.[speciesId]?.length) {
    const row = state.scores[speciesId];
    const s = row.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    predicted = {
      score: s.score,
      limiting: s.limitingFactor?.label || null,
      driving: s.drivingFactor?.label || null,
      coverage: s.coverage != null ? Math.round(s.coverage * 100) : null,
    };
  }

  const coefficient = tide.coefficient(t);

  return {
    /* position */
    lat: fix?.lat ?? null,
    lon: fix?.lon ?? null,
    accuracyM: fix?.accuracy != null ? Math.round(fix.accuracy) : null,
    fixAgeS: fix ? Math.round((t - fix.t) / 1000) : null,
    sogKn: fix?.speedKn ?? null,
    cogDeg: fix?.cogDeg ?? null,
    headingDeg: state.heading?.deg ?? null,
    nearestSpot,

    /* marée */
    tideSource: info.source,
    tideProvisional: info.provisional,
    heightM: round(tide.height(t), 2),
    coefficient,
    tideSense: drift.stream.sense,
    hoursFromHW: refHW ? round((t - refHW.t) / HOUR, 2) : null,
    hoursFromLW: refLW ? round((t - refLW.t) / HOUR, 2) : null,
    nextHWT: nextHW?.t ?? null,
    nextLWT: nextLW?.t ?? null,
    hoursToSlack: round(drift.stream.hoursToSlack, 2),
    // Signé : hoursToSlack est absolu, il dirait « après » même 20 min avant
    // le renverse. Or c'est justement le côté de l'étale qui intéresse.
    hoursFromSlack: round(drift.stream.hoursFromSlack, 2),
    slackT: drift.stream.slackT,
    /* Hauteur d'eau réelle = sonde carte + marée. On ne la donne QUE pour une
     * sonde ponctuelle relevée au sondeur. Additionner la marée à la borne
     * haute d'un secteur type large de deux milles produit un chiffre faux et
     * rassurant — exactement ce qu'il ne faut pas afficher en mer. Pour un
     * secteur, on rend la plage entière, qui reste une information honnête. */
    waterDepthM: pointSounding(nearestSpot) != null ? round(pointSounding(nearestSpot) + tide.height(t), 1) : null,
    waterDepthRangeM: !nearestSpot?.seed || !Array.isArray(nearestSpot?.depthM) ? null
      : [round(nearestSpot.depthM[0] + tide.height(t), 1), round(nearestSpot.depthM[1] + tide.height(t), 1)],

    /* courant */
    streamKn: round(drift.stream.spd, 2),
    streamDirDeg: Math.round(drift.stream.dir),
    driftKn: round(drift.spd, 2),
    driftDirDeg: Math.round(drift.dir),
    streamCalibrated: cfg.calibrated,

    /* météo et mer */
    windSpeedKn: round(wx?.windSpeedKn, 1),
    windDirDeg: wx?.windDirDeg != null ? Math.round(wx.windDirDeg) : null,
    windGustKn: round(wx?.windGustKn, 1),
    pressureHpa: round(wx?.pressureHpa, 1),
    pressureTrend6hHpa: round(hourly.length ? weather.pressureTrend6h(hourly, t) : null, 1),
    seaTempC: round(wx?.seaTempC, 1),
    airTempC: round(wx?.airTempC, 1),
    waveHeightM: round(wx?.waveHeightM, 2),
    wavePeriodS: round(wx?.wavePeriodS, 1),
    visibilityM: wx?.visibilityM ?? null,
    cloudPct: wx?.cloudPct ?? null,
    turbidity: round(hourly.length ? weather.turbidity(hourly, t, coefficient) : null, 2),
    weatherAgeMin: state.weather?.fetchedAt ? Math.round((t - state.weather.fetchedAt) / 60000) : null,
    weatherStale: !!state.weather?.stale,

    /* ressenti bord — la mer sous la coque, pas celle d'une maille de 8 km */
    seaStateOnboardM: round(state.motion?.hsEstimateM, 2),
    seaStateLabel: state.motion?.seaState?.label ?? null,

    /* nature du fond, si la carte EMODnet est embarquée. C'est le seul champ
       de l'instantané qui décrit le TERRAIN et non l'instant : deux prises au
       même endroit à six mois d'écart partagent leur fond, et c'est justement
       ce qui rend l'apprentissage par poste possible. */
    seabed: (() => {
      const g = seabed.at(pos.lat, pos.lon);
      return g ? { label: g.label, fr: g.fr, habitat: g.habitat } : null;
    })(),

    /* lumière */
    lightPhase: lightPhaseAt(t, pos.lat, pos.lon),
    sunAltitudeDeg: round(sunAltitude(new Date(t), pos.lat, pos.lon), 1),
    minutesFromSunrise: sun.sunriseT ? Math.round((t - sun.sunriseT) / 60000) : null,
    minutesFromSunset: sun.sunsetT ? Math.round((t - sun.sunsetT) / 60000) : null,
    moonPhase: round(moon.phase, 3),
    moonIllumination: round(moon.illumination, 2),
    moonName: moon.name,

    /* modèle */
    predicted,
  };
}

const round = (v, n) => (Number.isFinite(v) ? Number(v.toFixed(n)) : null);

/** Sonde ponctuelle d'un poste, ou null si ce n'est qu'une plage de secteur. */
function pointSounding(spot) {
  if (!spot || spot.seed || !Array.isArray(spot.depthM)) return null;
  const [a, b] = spot.depthM;
  return Math.abs(a - b) < 0.5 ? (a + b) / 2 : null;
}

/**
 * « −4.4 h » se lit mal quand on cherche à recaler une prise sur la marée.
 * On dit avant ou après, en heures et minutes.
 */
function tideOffsetLabel(hours) {
  if (!Number.isFinite(hours)) return '—';
  const total = Math.round(Math.abs(hours) * 60);
  const hh = Math.floor(total / 60);
  const mm = String(total % 60).padStart(2, '0');
  const dur = hh ? `${hh} h ${mm}` : `${total} min`;
  if (total < 3) return 'à l’étale';
  return `${dur} ${hours < 0 ? 'avant' : 'après'}`;
}

/* ==========================================================================
 * Enregistrement
 * ========================================================================== */

let lastSpeciesId = null;
let lastRecordId = null;

/**
 * LE geste. Un appel = une prise enregistrée, sans autre interaction.
 * @param {string} speciesId
 * @param {{name?:string, extra?:object, silent?:boolean}} opts
 */
export async function record(speciesId, opts = {}) {
  const t = Date.now();
  const info = speciesInfo(speciesId, opts.name);
  const snapshot = buildSnapshot(t, SPECIES_RULES[speciesId] ? speciesId : null);

  const rec = await learning.logCatch({
    t,
    speciesId,
    speciesName: info.name,
    custom: info.custom,
    count: opts.extra?.count ?? 1,
    released: opts.extra?.released ?? false,
    lengthCm: opts.extra?.lengthCm ?? null,
    note: opts.extra?.note ?? '',
    spotId: opts.extra?.spotId ?? snapshot.nearestSpot?.id ?? null,
    lat: snapshot.lat,
    lon: snapshot.lon,
    predictedScore: snapshot.predicted?.score ?? null,
    snapshot,
  });

  lastSpeciesId = speciesId;
  lastRecordId = rec.id;
  emit('catches:changed', rec);

  if (!opts.silent) {
    navigator.vibrate?.([18, 40, 18]);
    const where = snapshot.lat != null
      ? `${fmt.latDDM(snapshot.lat)} ${fmt.lonDDM(snapshot.lon)}`
      : 'sans position GPS';
    toast(`${info.emoji} ${info.name} — ${where}`, snapshot.lat != null ? 'good' : 'danger', 4200, {
      label: 'Annuler',
      onClick: () => undoLast(),
    });

    /* Contrôle de maille. Il arrive APRÈS l'enregistrement, jamais avant : un
     * poisson sous la maille se remet à l'eau tout de suite, et l'app n'a pas à
     * retenir la main de quelqu'un pendant qu'il tient un poisson vivant. Elle
     * le dit, l'enregistrement reste, et la remise à l'eau se coche après. */
    const size = catalog.sizeCheck(speciesId, rec.lengthCm);
    if (size.verdict === 'undersize') {
      toast(`⚠︎ Sous la maille : ${size.minSizeCm} cm pour ${info.name}. À remettre à l’eau.`, 'danger', 7000);
    } else if (size.verdict === 'forbidden') {
      toast(`⛔️ ${info.name} : espèce interdite à la capture. Relâcher immédiatement.`, 'danger', 8000);
    }
  }
  return rec;
}

/** Annulation immédiate — indispensable quand un seul tap suffit à écrire. */
export async function undoLast() {
  if (!lastRecordId) return false;
  await learning.removeCatch(lastRecordId);
  lastRecordId = null;
  emit('catches:changed');
  toast('Prise annulée');
  return true;
}

export const lastSpecies = () => (lastSpeciesId ? speciesInfo(lastSpeciesId) : null);

/* ==========================================================================
 * Feuille rapide
 * ========================================================================== */

/**
 * Grille d'espèces. Un tap enregistre et ferme. Rien d'autre n'est requis.
 * Le contexte (taille, nombre, remise à l'eau, note) est facultatif et se
 * règle AVANT le tap, via la barre d'options : on ne bloque jamais le geste.
 */
export function openQuickRecord() {
  const body = el('div');
  const extra = { count: 1, released: false, lengthCm: null, note: '' };

  /* ---- État de la capture GPS ------------------------------------------ */
  const fix = state.fix;
  const gpsRow = el('div', `banner ${fix ? 'info' : 'warn'}`);
  gpsRow.style.marginBottom = '10px';
  gpsRow.append(el('span', null, fix
    ? `📍 ${fmt.latDDM(fix.lat)} ${fmt.lonDDM(fix.lon)} · ±${Math.round(fix.accuracy || 0)} m`
    : '⚠︎ Pas de position GPS : la prise sera notée sans point. Le reste du contexte est enregistré.'));
  body.append(gpsRow);

  /* ---- Contexte, en lecture seule -------------------------------------- */
  const snap = buildSnapshot();
  const strip = el('div', 'strip');
  strip.style.marginBottom = '12px';
  const p = (v, l) => {
    const n = el('div', 'pill');
    n.append(el('div', 'pill-val', v), el('div', 'pill-lbl', l));
    return n;
  };
  strip.append(p(`${fmt.num(snap.heightM, 1)} m`, 'HAUTEUR'));
  strip.append(p(String(snap.coefficient), 'COEF'));
  strip.append(p(senseLabel(snap.tideSense), 'MARÉE'));
  strip.append(p(tideOffsetLabel(snap.hoursFromHW).replace(' avant', ' av.').replace(' après', ' ap.'), 'PLEINE MER'));
  strip.append(p(`${fmt.num(snap.driftKn, 1)} nd`, 'DÉRIVE'));
  if (snap.seaTempC != null) strip.append(p(`${fmt.num(snap.seaTempC, 1)}°`, 'EAU'));
  if (snap.windSpeedKn != null) strip.append(p(`${Math.round(snap.windSpeedKn)} nd`, `VENT ${fmt.cardinal(snap.windDirDeg)}`));
  body.append(strip);

  /* ---- Options rapides -------------------------------------------------- */
  const opts = el('div', 'row wrap');
  opts.style.marginBottom = '12px';

  const relBtn = el('button', 'chip chip-btn', '↩︎ Relâché');
  relBtn.type = 'button';
  relBtn.addEventListener('click', () => {
    extra.released = !extra.released;
    relBtn.classList.toggle('good', extra.released);
  });

  const countBtn = el('button', 'chip chip-btn', '×1');
  countBtn.type = 'button';
  countBtn.addEventListener('click', () => {
    extra.count = extra.count >= 10 ? 1 : extra.count + 1;
    countBtn.textContent = `×${extra.count}`;
    countBtn.classList.toggle('good', extra.count > 1);
  });

  const sizeBtn = el('button', 'chip chip-btn', '📏 Taille');
  sizeBtn.type = 'button';
  sizeBtn.addEventListener('click', () => {
    const v = prompt('Taille en cm ?', extra.lengthCm ?? '');
    if (v === null) return;
    extra.lengthCm = v.trim() ? Number(v.replace(',', '.')) : null;
    sizeBtn.textContent = extra.lengthCm ? `📏 ${extra.lengthCm} cm` : '📏 Taille';
    sizeBtn.classList.toggle('good', !!extra.lengthCm);
  });

  opts.append(relBtn, countBtn, sizeBtn);
  body.append(opts);

  /* ---- Grille d'espèces -------------------------------------------------- */
  body.append(el('div', 'tiny', 'Touche une espèce — c’est enregistré immédiatement.'));
  const grid = el('div', 'species-grid');

  const tile = (info) => {
    const b = el('button', 'species-tile');
    b.type = 'button';
    b.style.setProperty('--sp', info.color);
    b.append(el('span', 'species-emoji', info.emoji));
    b.append(el('span', 'species-name', info.name));
    if (SPECIES_RULES[info.id]) {
      const reg = getRegulationStatus(info.id, Date.now());
      if (reg.mode === 'closed') b.append(el('span', 'tag tag-closed', 'fermé'));
      else if (reg.mode === 'no-kill') b.append(el('span', 'tag tag-nokill', 'no-kill'));
    }
    b.addEventListener('click', async () => {
      b.disabled = true;
      closeSheet();
      await record(info.id, { name: info.name, extra });
    });
    return b;
  };

  for (const id of SPECIES_ORDER) grid.append(tile(speciesInfo(id)));
  for (const c of customSpecies) grid.append(tile(c));

  /* Le catalogue avant la saisie libre : une plie enregistrée depuis la fiche
   * garde son identifiant, sa maille et sa saison ; la même tapée à la main
   * devient une chaîne de caractères dont l'app ne saura plus rien. */
  const bookTile = el('button', 'species-tile species-tile--add');
  bookTile.type = 'button';
  bookTile.append(el('span', 'species-emoji', '📖'), el('span', 'species-name', 'Catalogue'));
  bookTile.addEventListener('click', () => {
    closeSheet();
    setTimeout(() => openSpeciesBook({
      title: 'Choisir l’espèce',
      onPick: (s) => record(s.id, { name: s.name, extra }),
    }), 80);
  });
  grid.append(bookTile);

  const addTile = el('button', 'species-tile species-tile--add');
  addTile.type = 'button';
  addTile.append(el('span', 'species-emoji', '✎'), el('span', 'species-name', 'Autre espèce'));
  addTile.addEventListener('click', () => openFreeName(extra));
  grid.append(addTile);

  body.append(grid);

  /* ---- Repli détaillé ---------------------------------------------------- */
  const more = button('Saisie détaillée…', 'btn-ghost btn-sm', () => {
    closeSheet();
    setTimeout(() => openDetailForm(null), 80);
  });
  more.style.marginTop = '12px';
  body.append(more);

  openSheet('Nouvelle prise', body);
}

/** Saisie d'un nom libre, mémorisé pour les fois suivantes. */
function openFreeName(extra) {
  const body = el('div');
  const f = el('div', 'field');
  f.append(el('label', null, 'Nom de l’espèce'));
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Ex. Vieille, congre, plie…';
  input.autocapitalize = 'sentences';
  f.append(input);
  body.append(f);
  body.append(el('p', 'tiny', 'Elle sera ajoutée à ta grille : la prochaine fois, un seul tap suffira.'));

  const validate = async () => {
    const created = await rememberCustom(input.value);
    if (!created) return void toast('Il faut un nom', 'danger');
    closeSheet();
    await record(created.id, { name: created.name, extra });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && validate());
  body.append(button('Enregistrer la prise', 'btn-lime btn-lg', validate));

  openSheet('Autre espèce', body);
  setTimeout(() => input.focus(), 120);
}

/* ==========================================================================
 * Saisie détaillée
 * --------------------------------------------------------------------------
 * Pour la prise qu'on veut vraiment documenter : le poisson de la saison, ou
 * une remise à l'eau qu'on décrit. Le contexte reste capturé automatiquement.
 * ========================================================================== */
export function openDetailForm(preselect = null) {
  const body = el('div');
  const mk = (label, node) => {
    const f = el('div', 'field');
    f.append(el('label', null, label), node);
    body.append(f);
    return node;
  };

  const sel = document.createElement('select');
  for (const id of SPECIES_ORDER) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = SPECIES_RULES[id].name;
    if (id === preselect) o.selected = true;
    sel.append(o);
  }
  for (const c of customSpecies) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === preselect) o.selected = true;
    sel.append(o);
  }
  const other = document.createElement('option');
  other.value = '__new__';
  other.textContent = '✎ Autre espèce…';
  sel.append(other);
  mk('Espèce', sel);

  const freeName = document.createElement('input');
  freeName.type = 'text';
  freeName.placeholder = 'Nom de l’espèce';
  const freeField = mk('Nom libre', freeName);
  freeField.parentElement.hidden = true;
  sel.addEventListener('change', () => {
    freeField.parentElement.hidden = sel.value !== '__new__';
  });

  const len = document.createElement('input');
  len.type = 'number';
  len.inputMode = 'decimal';
  len.placeholder = 'cm';
  mk('Taille', len);

  const cnt = document.createElement('input');
  cnt.type = 'number';
  cnt.inputMode = 'numeric';
  cnt.value = '1';
  mk('Nombre', cnt);

  const rel = el('div', 'seg');
  let released = false;
  const bKeep = el('button', 'on', 'Gardé');
  const bRel = el('button', '', 'Relâché');
  bKeep.type = bRel.type = 'button';
  bKeep.addEventListener('click', () => { released = false; bKeep.classList.add('on'); bRel.classList.remove('on'); });
  bRel.addEventListener('click', () => { released = true; bRel.classList.add('on'); bKeep.classList.remove('on'); });
  rel.append(bKeep, bRel);
  mk('Devenir', rel);

  const spotSel = document.createElement('select');
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Poste le plus proche (auto)';
  spotSel.append(auto);
  for (const s of spots.all()) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    spotSel.append(o);
  }
  mk('Poste', spotSel);

  const note = document.createElement('textarea');
  note.rows = 2;
  note.placeholder = 'Leurre, profondeur, comportement…';
  mk('Note', note);

  const snap = buildSnapshot();
  body.append(el('p', 'tiny',
    `Contexte capturé automatiquement : ${snap.lat != null ? 'position GPS, ' : ''}coef ${snap.coefficient}, ` +
    `${senseLabel(snap.tideSense)}, hauteur ${fmt.num(snap.heightM, 1)} m, dérive ${fmt.num(snap.driftKn, 1)} nd, ` +
    `${snap.lightPhase === 'night' ? 'nuit' : snap.lightPhase === 'twilight' ? 'crépuscule' : 'jour'}` +
    `${snap.seaTempC != null ? `, eau ${fmt.num(snap.seaTempC, 1)} °C` : ''}.`));

  body.append(button('Enregistrer', 'btn-lime btn-lg', async () => {
    let id = sel.value;
    let name = null;
    if (id === '__new__') {
      const created = await rememberCustom(freeName.value);
      if (!created) return void toast('Il faut un nom d’espèce', 'danger');
      id = created.id;
      name = created.name;
    }
    closeSheet();
    await record(id, {
      name,
      extra: {
        lengthCm: len.value ? Number(len.value) : null,
        count: Math.max(1, Number(cnt.value) || 1),
        released,
        spotId: spotSel.value || null,
        note: note.value.trim(),
      },
    });
  }));

  openSheet('Prise détaillée', body);
}

/* ==========================================================================
 * Bouton flottant
 * ========================================================================== */

/**
 * Toujours visible en NAV, CARTE et PÊCHE. Un tap ouvre la grille ; un appui
 * long réenregistre directement la dernière espèce, pour le banc de maquereaux
 * où l'on sort dix poissons en dix minutes.
 */
export function mountFab() {
  const fab = el('button', 'fab');
  fab.type = 'button';
  fab.id = 'fab-record';
  fab.setAttribute('aria-label', 'Enregistrer une prise');
  fab.append(el('span', 'fab-ico', '🎣'));
  document.body.append(fab);

  let longPressed = false;
  let timer = 0;

  const startPress = () => {
    longPressed = false;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!lastSpeciesId) return;
      longPressed = true;
      navigator.vibrate?.(25);
      await record(lastSpeciesId);
    }, 550);
  };
  const endPress = () => clearTimeout(timer);

  fab.addEventListener('touchstart', startPress, { passive: true });
  fab.addEventListener('touchend', endPress, { passive: true });
  fab.addEventListener('touchcancel', endPress, { passive: true });
  fab.addEventListener('mousedown', startPress);
  fab.addEventListener('mouseup', endPress);
  fab.addEventListener('mouseleave', endPress);

  fab.addEventListener('click', () => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    openQuickRecord();
  });

  return fab;
}

/** Le bouton disparaît sur le Journal : on y est déjà dans la saisie. */
export function setFabVisible(v) {
  const fab = document.getElementById('fab-record');
  if (fab) fab.hidden = !v;
}

const senseLabel = (s) => (s === 'flood' ? 'montant' : s === 'ebb' ? 'descendant' : 'étale');

/* ==========================================================================
 * Rendu du contexte d'une prise — partagé par le Journal et la carte
 * ========================================================================== */

/** Lignes lisibles du snapshot, regroupées, prêtes à afficher. */
export function describeSnapshot(s) {
  if (!s) return [];
  const groups = [];

  const pos = [];
  if (s.lat != null) pos.push(['Position', `${fmt.latDDM(s.lat)} ${fmt.lonDDM(s.lon)}`]);
  if (s.accuracyM != null) pos.push(['Précision GPS', `± ${s.accuracyM} m`]);
  if (s.nearestSpot) {
    pos.push(['Poste', `${s.nearestSpot.name} · ${fmt.dist(s.nearestSpot.distanceM)} au ${fmt.heading(s.nearestSpot.bearingDeg)}`]);
  }
  if (s.seabed) pos.push(['Nature du fond', s.seabed.fr]);
  if (s.waterDepthM != null) pos.push(["Hauteur d'eau", `${fmt.num(s.waterDepthM, 1)} m`]);
  else if (s.waterDepthRangeM) {
    pos.push(["Hauteur d'eau", `${fmt.num(s.waterDepthRangeM[0], 0)}–${fmt.num(s.waterDepthRangeM[1], 0)} m (secteur)`]);
  }
  if (pos.length) groups.push({ title: 'Position', rows: pos });

  const t = [
    ['Hauteur', `${fmt.num(s.heightM, 2)} m`],
    ['Coefficient', String(s.coefficient)],
    ['Sens', senseLabel(s.tideSense)],
  ];
  if (s.hoursFromHW != null) t.push(['Pleine mer', tideOffsetLabel(s.hoursFromHW)]);
  if (s.hoursFromLW != null) t.push(['Basse mer', tideOffsetLabel(s.hoursFromLW)]);
  if (s.hoursFromSlack != null) t.push(['Étale de courant', tideOffsetLabel(s.hoursFromSlack)]);
  else if (s.hoursToSlack != null) t.push(['Étale de courant', `${fmt.num(s.hoursToSlack, 1)} h`]);
  t.push(['Source marée', s.tideSource === 'SHOM' ? 'SHOM' : s.tideProvisional ? 'harmonique provisoire' : 'harmonique ajusté']);
  groups.push({ title: 'Marée', rows: t });

  const c = [
    ['Courant', `${fmt.num(s.streamKn, 1)} nd → ${fmt.heading(s.streamDirDeg)} ${fmt.cardinal(s.streamDirDeg)}`],
    ['Dérive bateau', `${fmt.num(s.driftKn, 1)} nd → ${fmt.heading(s.driftDirDeg)}`],
    ['Modèle', s.streamCalibrated ? 'calibré' : 'non calibré'],
  ];
  groups.push({ title: 'Courant', rows: c });

  const m = [];
  if (s.windSpeedKn != null) {
    m.push(['Vent', `${fmt.windFrom(s.windDirDeg)}, ${Math.round(s.windSpeedKn)} nd${
      s.windGustKn ? ` (raf. ${Math.round(s.windGustKn)})` : ''}`]);
  }
  if (s.waveHeightM != null) m.push(['Mer', `${fmt.num(s.waveHeightM, 1)} m${s.wavePeriodS ? ` / ${Math.round(s.wavePeriodS)} s` : ''}`]);
  if (s.seaStateOnboardM != null) m.push(['Ressenti bord', `${fmt.num(s.seaStateOnboardM, 1)} m${s.seaStateLabel ? ` — ${s.seaStateLabel}` : ''}`]);
  if (s.seaTempC != null) m.push(["Température de l'eau", `${fmt.num(s.seaTempC, 1)} °C`]);
  if (s.pressureHpa != null) {
    m.push(['Pression', `${Math.round(s.pressureHpa)} hPa${
      s.pressureTrend6hHpa != null ? ` (${s.pressureTrend6hHpa > 0 ? '+' : ''}${fmt.num(s.pressureTrend6hHpa, 1)} / 6 h)` : ''}`]);
  }
  if (s.turbidity != null) m.push(["Clarté de l'eau", s.turbidity > 0.45 ? `brassée (${Math.round(s.turbidity * 100)} %)` : `claire (${Math.round(s.turbidity * 100)} %)`]);
  if (s.visibilityM != null) m.push(['Visibilité', `${(s.visibilityM / 1000).toFixed(1)} km`]);
  if (s.weatherAgeMin != null) m.push(['Fraîcheur météo', s.weatherAgeMin < 90 ? `${s.weatherAgeMin} min` : `${Math.round(s.weatherAgeMin / 60)} h`]);
  if (m.length) groups.push({ title: 'Météo et mer', rows: m });

  const l = [
    ['Lumière', { night: 'Nuit', twilight: 'Crépuscule', day: 'Jour' }[s.lightPhase] || s.lightPhase],
  ];
  if (s.sunAltitudeDeg != null) l.push(['Hauteur du soleil', `${fmt.num(s.sunAltitudeDeg, 0)}°`]);
  if (s.minutesFromSunrise != null && Math.abs(s.minutesFromSunrise) < 240) {
    l.push(['Du lever', `${s.minutesFromSunrise > 0 ? '+' : ''}${s.minutesFromSunrise} min`]);
  }
  if (s.minutesFromSunset != null && Math.abs(s.minutesFromSunset) < 240) {
    l.push(['Du coucher', `${s.minutesFromSunset > 0 ? '+' : ''}${s.minutesFromSunset} min`]);
  }
  if (s.moonName) l.push(['Lune', `${s.moonName} · ${Math.round((s.moonIllumination ?? 0) * 100)} %`]);
  groups.push({ title: 'Lumière', rows: l });

  if (s.predicted) {
    const pr = [['Score prédit', `${s.predicted.score}/100`]];
    if (s.predicted.driving) pr.push(['Ce qui portait', s.predicted.driving]);
    if (s.predicted.limiting) pr.push(['Ce qui freinait', s.predicted.limiting]);
    if (s.predicted.coverage != null && s.predicted.coverage < 90) {
      pr.push(['Couverture', `${s.predicted.coverage} % des facteurs`]);
    }
    groups.push({ title: 'Modèle', rows: pr });
  }

  return groups;
}

/** Rendu DOM des groupes ci-dessus. */
export function renderSnapshot(snapshot) {
  const frag = document.createDocumentFragment();
  for (const g of describeSnapshot(snapshot)) {
    frag.append(el('div', 'list-title', g.title));
    for (const [k, v] of g.rows) {
      const r = el('div', 'row');
      r.style.justifyContent = 'space-between';
      r.style.padding = '2px 0';
      const key = el('span', 'tiny', k);
      const val = el('span', 'tnum', v);
      val.style.fontSize = '13px';
      val.style.fontWeight = '600';
      val.style.textAlign = 'right';
      r.append(key, val);
      frag.append(r);
    }
    frag.append(el('div', 'hr'));
  }
  return frag;
}

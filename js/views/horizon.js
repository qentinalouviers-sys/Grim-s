/* ==========================================================================
 * views/horizon.js — mode HORIZON : veille visuelle et identification des feux
 * --------------------------------------------------------------------------
 * Le mode qui répond à la question qu'on se pose vraiment de nuit, et qu'aucune
 * app de navigation grand public ne traite : « c'est quoi, ce feu, là-bas ? »
 *
 * Trois outils, dans l'ordre où on s'en sert :
 *
 * 1. LE BANDEAU D'HORIZON. Le champ visuel réel autour du cap, avec les
 *    marques du balisage posées à leur relèvement, dessinées comme sur la
 *    carte. On lève les yeux, on baisse les yeux, c'est au même endroit.
 *
 * 2. L'IDENTIFICATEUR. On décrit ce qu'on voit — couleur, rythme, et surtout
 *    la PÉRIODE, qu'on donne en tapant l'écran en cadence avec les éclats.
 *    Compter « vingt-et-un, vingt-deux » en pleine mer est le moyen le plus sûr
 *    de se tromper d'une seconde ; taper du doigt ne demande aucun calcul, et
 *    la médiane de quatre intervalles vaut mieux qu'un chronométrage unique.
 *
 * 3. LA LISTE. Ce qui est autour, avec le verdict de visibilité : portée du
 *    feu, portée géographique, visibilité météo — et lequel des trois limite.
 *    Chaque marque est un but de navigation en un tap.
 *
 * ── HONNÊTETÉ ─────────────────────────────────────────────────────────────
 * Les données viennent d'OpenStreetMap : contributives, donc parfois
 * incomplètes ou périmées. Elles ne remplacent pas les Instructions Nautiques
 * ni la carte officielle, et l'écran le dit. Une identification proposée reste
 * une hypothèse à confirmer à la carte : on affiche pourquoi chaque candidat
 * est classé là où il est, plutôt qu'un verdict qui ne se discute pas.
 * ========================================================================== */

import { state, subscribe, set } from '../core/store.js';
import { el, clear, button, chip, toast, openSheet, closeSheet } from '../ui/dom.js';
import { HorizonStrip } from '../ui/widgets.js';
import * as fmt from '../core/fmt.js';
import * as seamarks from '../data/seamarks.js';
import * as spots from '../fishing/spots.js';
import * as weather from '../data/weather.js';
import * as idb from '../core/idb.js';
import { lightPhaseAt } from '../data/astro.js';
import { startNav } from '../ui/destination.js';

const PHASE_LABEL = { night: 'nuit noire', twilight: 'crépuscule', day: 'plein jour' };

let root;
let unsubs = [];
let strip = null;
let refs = {};
let timer = 0;
let items = [];
let listCache = [];
let pendingFrame = 0;
let loading = false;

/** Observation en cours de saisie dans l'identificateur. */
let obs = { colour: null, character: null, periodS: null, useBearing: false };
let taps = [];

export function mount(container) {
  root = clear(container);
  refs = {};

  /* ---- Bandeau d'horizon ------------------------------------------------ */
  const stripCard = el('div', 'card tight');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'CHAMP VISUEL'), el('div', 'spacer'));
  refs.headingChip = chip('—');
  head.append(refs.headingChip);
  stripCard.append(head);
  const sWrap = el('div');
  stripCard.append(sWrap);
  strip = new HorizonStrip(sWrap, { height: 190 });
  refs.stripNote = el('div', 'tiny');
  stripCard.append(refs.stripNote);
  root.append(stripCard);

  /* ---- État du balisage ------------------------------------------------- */
  refs.status = el('div', 'card tight');
  root.append(refs.status);

  /* ---- Identificateur de feu -------------------------------------------- */
  refs.ident = el('div', 'card');
  root.append(refs.ident);
  buildIdentifier();

  /* ---- Liste ------------------------------------------------------------ */
  refs.list = el('div', 'card flush');
  root.append(refs.list);

  root.append(el('div', 'tiny',
    'Balisage OpenStreetMap / OpenSeaMap — donnée contributive, sans garantie. '
    + 'Ne remplace ni la carte marine officielle, ni les Instructions Nautiques, ni la veille visuelle.'));

  unsubs.push(subscribe('heading', onHeading));
  unsubs.push(subscribe(['fix', 'weather'], recompute));
  timer = setInterval(recompute, 20000);

  recompute();
  autoLoad();
}

export function unmount() {
  unsubs.forEach((fn) => fn());
  unsubs = [];
  clearInterval(timer);
  cancelAnimationFrame(pendingFrame);
  pendingFrame = 0;
  strip?.destroy();
  strip = null;
  refs = {};
}

export function refresh() {
  recompute();
}

/* --------------------------------------------------------------------------
 * Chargement du balisage
 * ------------------------------------------------------------------------ */
async function autoLoad() {
  const pos = state.fix || spots.getPort();
  const cur = seamarks.current();
  // On ne redemande pas ce qu'on a déjà : le cache tient un mois, et une
  // requête Overpass coûte cher à un serveur bénévole.
  if (cur.marks.length && cur.center && Math.hypot(cur.center.lat - pos.lat, cur.center.lon - pos.lon) * 111 < 15) {
    return;
  }
  await download({ silent: true });
}

async function download({ silent = false, force = false } = {}) {
  if (loading) return;
  loading = true;
  renderStatus();
  const pos = state.fix || spots.getPort();
  try {
    const res = await seamarks.load(pos, { radiusKm: 30, force });
    if (res.error || !res.marks.length) {
      if (!silent) toast('Balisage indisponible — réessaie avec du réseau', 'danger');
    } else if (!silent) {
      toast(`${res.marks.length} marques en mémoire`, 'good');
    }
  } finally {
    loading = false;
    recompute();
  }
}

/* --------------------------------------------------------------------------
 * Rendu
 * ------------------------------------------------------------------------ */

/** Le cap change vite : on redessine au plus une fois par frame, jamais plus. */
function onHeading() {
  if (pendingFrame || !strip) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    const hdg = state.heading?.deg ?? state.fix?.cogDeg ?? 0;
    strip.set(hdg, items);
    if (refs.headingChip) refs.headingChip.textContent = `cap ${fmt.heading(hdg)}`;
  });
}

function recompute() {
  if (!refs.status) return;
  const pos = state.fix || spots.getPort();
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, Date.now()) : null;
  const eyeHeightM = state.settings?.eyeHeightM ?? seamarks.DEFAULT_EYE_HEIGHT_M;
  const opts = { eyeHeightM, visibilityM: wx?.visibilityM ?? null };

  listCache = seamarks.nearby(pos, { maxNm: 12, limit: 40, ...opts });

  items = listCache.map((m) => ({
    bearingDeg: m.bearingDeg,
    distanceNm: m.distanceNm,
    colours: seamarks.cssColours(m),
    topmark: m.topmark,
    topmarkColour: m.topmarkColour ? seamarks.COLOUR_CSS[m.topmarkColour.split(';')[0]] : null,
    label: m.name || seamarks.describe(m),
    sub: m.light ? seamarks.lightString(m.light) : fmt.dist(m.distanceM),
    lit: m.vis.visible ? seamarks.lightCss(m.light) : null,
    dim: !m.vis.visible,
  }));

  onHeading();
  renderStatus();
  renderList();
  renderIdentResults();

  const phase = PHASE_LABEL[lightPhaseAt(Date.now(), pos.lat, pos.lon)] || '';
  refs.stripNote.textContent = listCache.length
    ? `${listCache.length} marques à moins de 12 NM · hauteur d’œil ${eyeHeightM} m`
      + `${wx?.visibilityM != null ? ` · visibilité ${fmt.dist(wx.visibilityM)}` : ''}`
      + `${phase ? ` · ${phase}` : ''}`
    : 'Aucune marque en mémoire pour ce secteur.';
}

function renderStatus() {
  const box = clear(refs.status);
  const cur = seamarks.current();

  const row = el('div', 'row');
  const main = el('div', 'list-main');
  main.append(el('div', 'list-title', cur.marks.length
    ? `${cur.marks.length} marques en mémoire`
    : 'Balisage non téléchargé'));
  main.append(el('div', 'list-sub', cur.fetchedAt
    ? `Rayon ${cur.radiusKm} km · relevé ${fmt.age(cur.fetchedAt)}${cur.stale ? ' (cache)' : ''}`
    : 'Télécharge le balisage au port : il reste ensuite disponible hors réseau.'));
  row.append(main);

  const dl = button(loading ? '…' : '⤓', 'btn-sm', () => download({ force: true }));
  dl.disabled = loading;
  row.append(dl);
  box.append(row);

  if (!state.online && !cur.marks.length) {
    box.append(el('div', 'banner warn', 'Hors ligne et sans balisage en mémoire : ce mode reste vide tant qu’il n’a pas été téléchargé une fois.'));
  }

  /* Hauteur d'œil : elle change la portée géographique de plusieurs milles
   * entre un cockpit et une passerelle. C'est un réglage, pas une constante. */
  const eye = el('div', 'row wrap');
  eye.style.marginTop = '8px';
  eye.append(el('span', 'tiny', 'Hauteur d’œil'));
  for (const h of [1, 2, 3, 5, 8]) {
    const cur2 = (state.settings?.eyeHeightM ?? seamarks.DEFAULT_EYE_HEIGHT_M) === h;
    const b = el('button', `chip chip-btn${cur2 ? ' good' : ''}`, `${h} m`);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const settings = { ...(state.settings || {}), eyeHeightM: h };
      set({ settings });
      await idb.put('kv', 'settings', settings);
      recompute();
    });
    eye.append(b);
  }
  box.append(eye);
}

/* --------------------------------------------------------------------------
 * Identificateur de feu
 * ------------------------------------------------------------------------ */
function buildIdentifier() {
  const box = clear(refs.ident);
  const head = el('div', 'card-head');
  head.append(el('h3', null, '🔦 IDENTIFIER UN FEU'));
  box.append(head);

  /* --- Couleur ---------------------------------------------------------- */
  const colRow = el('div', 'row wrap');
  for (const [key, label] of seamarks.COLOURS) {
    const b = el('button', 'chip chip-btn', label);
    b.type = 'button';
    b.dataset.colour = key;
    b.addEventListener('click', () => {
      obs.colour = obs.colour === key ? null : key;
      paintChips();
      renderIdentResults();
    });
    colRow.append(b);
  }
  box.append(el('div', 'tiny', 'Couleur observée'), colRow);

  /* --- Rythme ------------------------------------------------------------ */
  const chRow = el('div', 'row wrap');
  chRow.style.marginTop = '6px';
  for (const [key, label] of seamarks.CHARACTERS) {
    const b = el('button', 'chip chip-btn', label);
    b.type = 'button';
    b.dataset.character = key;
    b.addEventListener('click', () => {
      obs.character = obs.character === key ? null : key;
      paintChips();
      renderIdentResults();
    });
    chRow.append(b);
  }
  box.append(el('div', 'tiny', 'Rythme'), chRow);

  /* --- Tap tempo --------------------------------------------------------- */
  const tapWrap = el('div');
  tapWrap.style.marginTop = '10px';
  refs.tap = el('button', 'tap-tempo');
  refs.tap.type = 'button';
  refs.tap.append(el('div', 'tap-main', 'TAPE EN CADENCE'));
  refs.tapVal = el('div', 'tap-sub', 'avec chaque éclat du feu');
  refs.tap.append(refs.tapVal);
  refs.tap.addEventListener('click', onTap);
  tapWrap.append(refs.tap);

  const reset = button('Effacer', 'btn-sm btn-ghost', () => {
    taps = [];
    obs = { colour: null, character: null, periodS: null, useBearing: false };
    paintChips();
    paintTap();
    renderIdentResults();
  });
  tapWrap.append(reset);
  box.append(tapWrap);

  /* --- Relèvement -------------------------------------------------------- */
  const brgRow = el('div', 'row');
  brgRow.style.marginTop = '8px';
  refs.brgBtn = el('button', 'chip chip-btn', '🧭 Pointer avec le compas');
  refs.brgBtn.type = 'button';
  refs.brgBtn.addEventListener('click', () => {
    const hdg = state.heading?.deg;
    if (!Number.isFinite(hdg)) return void toast('Compas indisponible', 'danger');
    if (obs.useBearing) {
      obs.useBearing = false;
      obs.bearingDeg = null;
    } else {
      obs.useBearing = true;
      obs.bearingDeg = hdg;
      toast(`Relèvement figé au ${fmt.heading(hdg)}`, 'good');
    }
    paintChips();
    renderIdentResults();
  });
  brgRow.append(refs.brgBtn);
  box.append(brgRow);
  box.append(el('p', 'tiny', 'Vise le feu avec le haut du téléphone, puis appuie : le relèvement du compas devient un critère de tri.'));

  refs.identResults = el('div');
  box.append(refs.identResults);

  paintChips();
  paintTap();
}

function paintChips() {
  for (const b of refs.ident.querySelectorAll('[data-colour]')) {
    b.classList.toggle('good', b.dataset.colour === obs.colour);
  }
  for (const b of refs.ident.querySelectorAll('[data-character]')) {
    b.classList.toggle('good', b.dataset.character === obs.character);
  }
  refs.brgBtn.classList.toggle('good', !!obs.useBearing);
  refs.brgBtn.textContent = obs.useBearing
    ? `🧭 ${fmt.heading(obs.bearingDeg)} — annuler`
    : '🧭 Pointer avec le compas';
}

/**
 * Mesure de période par tapotement. La médiane des intervalles est préférée à
 * la moyenne : un tap raté au milieu de la série double un intervalle, et une
 * moyenne s'en trouve décalée de plusieurs secondes là où la médiane l'ignore.
 */
function onTap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 20000) taps = [];
  taps.push(now);
  if (taps.length > 12) taps.shift();
  navigator.vibrate?.(8);

  if (taps.length >= 3) {
    const gaps = [];
    for (let i = 1; i < taps.length; i++) gaps.push((taps[i] - taps[i - 1]) / 1000);
    gaps.sort((a, b) => a - b);
    const mid = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
    obs.periodS = Number(mid.toFixed(1));
  }
  paintTap();
  renderIdentResults();
}

function paintTap() {
  refs.tapVal.textContent = obs.periodS
    ? `période ${obs.periodS.toFixed(1)} s · ${taps.length} taps`
    : taps.length
      ? `${taps.length} tap${taps.length > 1 ? 's' : ''} — encore ${Math.max(0, 3 - taps.length)}`
      : 'avec chaque éclat du feu';
  refs.tap.classList.toggle('on', !!obs.periodS);
}

function renderIdentResults() {
  if (!refs.identResults) return;
  const box = clear(refs.identResults);
  if (!obs.colour && !obs.character && !obs.periodS && !obs.useBearing) return;

  const pos = state.fix || spots.getPort();
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, Date.now()) : null;
  const res = seamarks.identify(obs, pos, {
    eyeHeightM: state.settings?.eyeHeightM ?? seamarks.DEFAULT_EYE_HEIGHT_M,
    visibilityM: wx?.visibilityM ?? null,
  });

  box.append(el('div', 'hr'));
  if (!res.length) {
    box.append(el('div', 'empty', 'Aucun feu connu ne correspond. Élargis les critères, ou vérifie que le balisage du secteur est téléchargé.'));
    return;
  }
  box.append(el('div', 'list-title', `${res.length} candidat${res.length > 1 ? 's' : ''}`));
  for (const c of res) {
    box.append(markRow(c, { score: c.score, reasons: c.reasons }));
  }
}

/* --------------------------------------------------------------------------
 * Liste des marques
 * ------------------------------------------------------------------------ */
function renderList() {
  const box = clear(refs.list);
  const head = el('div', 'card-head');
  head.style.padding = '12px 12px 0';
  head.append(el('h3', null, 'AUTOUR DE TOI'));
  box.append(head);

  if (!listCache.length) {
    box.append(el('div', 'empty', 'Rien à afficher. Télécharge le balisage du secteur (bouton ⤓).'));
    return;
  }
  for (const m of listCache.slice(0, 20)) box.append(markRow(m));
}

function markRow(m, extra = {}) {
  const b = el('button', 'list-item');
  b.type = 'button';

  const badge = el('div', 'score-badge');
  const cols = seamarks.cssColours(m);
  badge.style.background = `linear-gradient(180deg, ${cols.map((c, i) => `${c} ${(i / cols.length) * 100}%, ${c} ${((i + 1) / cols.length) * 100}%`).join(', ')})`;
  badge.style.color = '#050b14';
  badge.textContent = m.light ? '💡' : '';
  b.append(badge);

  const main = el('div', 'list-main');
  main.append(el('div', 'list-title', m.name || seamarks.describe(m)));
  const bits = [
    m.name ? seamarks.describe(m) : null,
    m.light ? seamarks.lightString(m.light) : null,
    `${fmt.dist(m.distanceM)} au ${fmt.heading(m.bearingDeg)}`,
  ].filter(Boolean);
  main.append(el('div', 'list-sub', bits.join(' · ')));

  if (!m.vis.visible) {
    main.append(el('div', 'tiny', `Sous l’horizon ou hors de portée — limite ${m.vis.limitNm.toFixed(1)} NM (${m.vis.limitedBy})`));
  } else if (m.vis.lit) {
    main.append(el('div', 'tiny', `Visible jusqu’à ${m.vis.limitNm.toFixed(1)} NM (${m.vis.limitedBy})`));
  }
  if (extra.reasons?.length) {
    main.append(el('div', 'tiny', `Concordance : ${extra.reasons.join(', ')}`));
  }
  b.append(main);

  if (extra.score != null) {
    const s = el('div', 'list-right');
    s.append(el('div', 'tnum', String(Math.round(extra.score))));
    b.append(s);
  }

  b.addEventListener('click', () => openMark(m));
  return b;
}

function openMark(m) {
  const body = el('div');
  body.append(el('div', 'list-title', seamarks.describe(m)));
  if (m.light) {
    body.append(el('div', 'metric-val sm c-amber tnum', seamarks.lightString(m.light)));
    const l = m.light;
    const lines = [
      l.periodS ? `Période ${l.periodS} s` : null,
      l.rangeNm ? `Portée nominale ${l.rangeNm} NM` : null,
      (l.heightM ?? m.heightM) ? `Hauteur ${l.heightM ?? m.heightM} m` : null,
      m.vis.geographicNm ? `Portée géographique ${m.vis.geographicNm.toFixed(1)} NM à ${state.settings?.eyeHeightM ?? seamarks.DEFAULT_EYE_HEIGHT_M} m d’œil` : null,
    ].filter(Boolean);
    body.append(el('p', 'tiny', lines.join(' · ')));
    if (l.sectors.length > 1) {
      body.append(el('div', 'list-sub', 'Secteurs :'));
      for (const s of l.sectors) {
        body.append(el('div', 'tiny',
          `${s.colour} ${s.fromDeg != null ? `${Math.round(s.fromDeg)}° → ${Math.round(s.toDeg ?? 0)}°` : ''}`));
      }
    }
  }
  body.append(el('p', 'tiny', `${fmt.posDDM(m)} · ${fmt.dist(m.distanceM)} au ${fmt.heading(m.bearingDeg)}`));
  if (m.fogSignal) body.append(el('p', 'tiny', `Signal de brume : ${m.fogSignal}`));
  if (m.racon) body.append(el('p', 'tiny', 'Répondeur radar (racon).'));

  const acts = el('div', 'btn-row');
  acts.append(
    button('🎯 Naviguer', 'btn-primary', () => {
      startNav({ lat: m.lat, lon: m.lon, name: m.name || seamarks.describe(m), kind: 'seamark' });
    }),
    button('📍 Marque', '', async () => {
      await spots.addSpot({
        name: m.name || seamarks.describe(m),
        lat: m.lat,
        lon: m.lon,
        note: [seamarks.describe(m), m.light ? seamarks.lightString(m.light) : null].filter(Boolean).join(' · '),
      });
      closeSheet();
      toast('Repère enregistré', 'good');
    }),
  );
  body.append(acts);
  body.append(el('p', 'tiny', 'Donnée OpenStreetMap : à confirmer sur la carte marine officielle avant toute décision de route.'));
  openSheet(m.name || 'Marque', body);
}

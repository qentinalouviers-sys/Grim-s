/* ==========================================================================
 * views/fish.js — mode PÊCHE
 * --------------------------------------------------------------------------
 * Trois niveaux de lecture, dans cet ordre, parce que c'est l'ordre des
 * questions qu'on se pose :
 *
 *   1. LE PLAN      « qu'est-ce que je fais, maintenant et dans deux heures »
 *   2. LA GRILLE    espèces × heures — la vue d'ensemble, pour décider soi-même
 *   3. LE DÉTAIL    pourquoi ce score, où aller, avec quoi, et ce que dit la loi
 *
 * Une app qui n'affiche que la grille laisse tout le travail au pêcheur ; une
 * app qui n'affiche que le plan ne se laisse pas contredire. Il faut les deux.
 * ========================================================================== */

import { state, subscribe, emit, set } from '../core/store.js';
import { el, clear, card, button, toast, openSheet, closeSheet, heatColor, scoreBadge, factorBars } from '../ui/dom.js';
import * as fmt from '../core/fmt.js';
import { SPECIES_RULES, SPECIES_ORDER, getRegulationStatus, REGULATION_META } from '../fishing/species.js';
import * as catalog from '../fishing/catalog.js';
import { openSpeciesBook } from '../ui/speciesbook.js';
import { findWindows } from '../fishing/engine.js';
import * as spots from '../fishing/spots.js';
import * as weather from '../data/weather.js';
import * as learning from '../fishing/learning.js';
import * as tide from '../data/tide.js';
import * as record from '../fishing/record.js';

let root;
let unsub;
let refs = {};
let dayOffset = 0;

export function mount(container) {
  root = clear(container);

  refs.head = el('div', 'card');
  refs.warn = el('div');
  refs.cond = el('div', 'card tight');
  refs.plan = el('div');
  refs.grid = el('div', 'card');
  refs.foot = el('div', 'tiny');

  root.append(refs.head, refs.warn, refs.cond, refs.plan, refs.grid, refs.foot);

  unsub = subscribe(['advice', 'scores', 'samples', 'weather', 'fix'], render);
  render();
}

export function unmount() {
  unsub?.();
  refs = {};
}

/* ==========================================================================
 * Rendu
 * ========================================================================== */
function render() {
  const a = state.advice;
  const scores = state.scores;
  const samples = state.samples || [];

  /* ---- Titre + sélecteur de jour --------------------------------------- */
  const head = clear(refs.head);
  if (!a || !scores) {
    head.append(el('div', 'muted', 'Calcul en cours…'));
    return;
  }
  head.append(el('h2', 'list-title', a.headline));
  head.append(el('div', 'list-sub', a.subline));

  const seg = el('div', 'seg');
  seg.style.marginTop = '10px';
  ['Aujourd’hui', 'Demain', 'J+2'].forEach((label, i) => {
    const b = el('button', dayOffset === i ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      dayOffset = i;
      render();
    });
    seg.append(b);
  });
  head.append(seg);

  /* Le catalogue complet, à un tap du tableau des scores. Sept espèces sont
   * scorées ; il s'en pêche soixante sur la côte, et la question « je peux le
   * garder ? » ne se pose jamais pour celles qu'on attendait. */
  const bookBtn = button(`📖 Les ${catalog.count()} espèces des côtes normandes`, 'btn-sm', () => openSpeciesBook());
  bookBtn.style.marginTop = '10px';
  head.append(bookBtn);

  /* ---- Avertissements --------------------------------------------------- */
  const warn = clear(refs.warn);
  for (const w of a.warnings || []) {
    warn.append(el('div', `banner ${w.level}`, w.text));
  }

  /* ---- Conditions ------------------------------------------------------- */
  const cond = clear(refs.cond);
  const strip = el('div', 'strip');
  for (const c of a.conditions || []) {
    const p = el('div', 'pill');
    p.style.minWidth = '84px';
    p.append(el('div', 'pill-val', c.value), el('div', 'pill-lbl', c.label));
    strip.append(p);
  }
  cond.append(strip);

  /* ---- Plan ------------------------------------------------------------- */
  const plan = clear(refs.plan);
  const planCard = el('div', 'card');
  const ph = el('div', 'card-head');
  ph.append(el('h3', null, 'PLAN DE SORTIE'));
  planCard.append(ph);

  if (!a.plan?.length) {
    planCard.append(el('div', 'empty', 'Aucune fenêtre exploitable dans les 14 prochaines heures.'));
  } else {
    for (const p of a.plan) {
      const item = el('button', 'list-item');
      item.type = 'button';
      item.style.borderRadius = '10px';
      item.style.background = 'rgba(16,29,46,.5)';
      item.style.marginBottom = '6px';

      const main = el('div', 'list-main');
      main.append(el('div', 'list-title', `${SPECIES_RULES[p.speciesId].emoji} ${p.title}`));
      for (const line of p.lines) {
        const l = el('div', 'list-sub', line);
        l.style.whiteSpace = 'pre-wrap';
        main.append(l);
      }
      item.append(main, scoreBadge(p.score));
      item.addEventListener('click', () => showSpecies(p.speciesId));
      planCard.append(item);
    }
  }
  plan.append(planCard);

  /* ---- Grille ----------------------------------------------------------- */
  renderGrid(scores, samples);

  /* ---- Pied ------------------------------------------------------------- */
  const foot = clear(refs.foot);
  foot.append(el('div', null,
    `Réglementation ${REGULATION_META.year} · ${REGULATION_META.zone} · vérifiée le ${REGULATION_META.checked}. ` +
    'À reconfirmer auprès de la DIRM Manche Est – Mer du Nord avant chaque saison.'));
  const m = learning.model();
  if (m.totalCatches) {
    foot.append(el('div', null, `Modèle ajusté sur ${m.totalCatches} prises enregistrées sur cet appareil.`));
  }

  const logBtn = button('🎣 Enregistrer une prise', 'btn-lime btn-lg', () => record.openQuickRecord());
  logBtn.style.marginTop = '10px';
  foot.append(logBtn);
}

function renderGrid(scores, samples) {
  const box = clear(refs.grid);
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'ESPÈCES × HEURES'), el('div', 'spacer'));
  head.append(el('span', 'tiny', 'touche une case'));
  box.append(head);

  if (!samples.length) {
    box.append(el('div', 'empty', 'Pas de données.'));
    return;
  }

  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const from = dayStart.valueOf() + dayOffset * 86400000;
  const to = from + 86400000;

  const stepMin = samples.length > 1 ? Math.round((samples[1].t - samples[0].t) / 60000) : 30;
  const stride = Math.max(1, Math.round(60 / stepMin));
  const cols = samples.filter((s, i) => i % stride === 0 && s.t >= from && s.t < to);

  if (!cols.length) {
    box.append(el('div', 'empty', 'Hors de la fenêtre calculée. Reviens sur aujourd’hui.'));
    return;
  }

  const scroll = el('div', 'heat-scroll');
  const table = el('table', 'heat');

  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'h-sp'));
  for (const c of cols) hr.append(el('th', 'h-hr', String(new Date(c.t).getHours()).padStart(2, '0')));
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const id of SPECIES_ORDER) {
    const rule = SPECIES_RULES[id];
    const row = scores[id] || [];
    const reg = getRegulationStatus(id, from);
    const tr = el('tr');

    const th = el('th', 'h-sp');
    const nameRow = el('div', 'row');
    nameRow.append(el('span', null, `${rule.emoji} ${rule.name}`));
    th.append(nameRow);
    if (reg.mode === 'closed') th.append(el('small', null, '⛔ FERMÉ'));
    else if (reg.mode === 'no-kill') th.append(el('small', null, '↩︎ NO-KILL'));
    else th.append(el('small', null, `${rule.regulation.minSizeCm ? `${rule.regulation.minSizeCm} cm` : '—'}${rule.regulation.dailyBag ? ` · ${rule.regulation.dailyBag}/j` : ''}`));
    th.addEventListener('click', () => showSpecies(id));
    tr.append(th);

    for (const c of cols) {
      const s = row.reduce((best, cur) => (Math.abs(cur.t - c.t) < Math.abs(best.t - c.t) ? cur : best), row[0]);
      const td = el('td');
      const cell = el('div', 'cell', String(s?.score ?? 0));
      const col = heatColor(s?.score ?? 0);
      cell.style.background = col.background;
      cell.style.color = col.color;
      if (reg.mode === 'closed') cell.style.opacity = '0.32';
      if (Math.abs(c.t - now) < stride * stepMin * 30000) cell.classList.add('now');
      cell.title = `${rule.name} · ${fmt.hhmm(c.t)} · ${s?.score}/100${
        s?.limitingFactor ? ` · frein : ${s.limitingFactor.label}` : ''
      }`;
      cell.addEventListener('click', () => showMoment(id, s, c));
      td.append(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  scroll.append(table);
  box.append(scroll);
}

/* ==========================================================================
 * Détail espèce
 * ========================================================================== */
function showSpecies(id) {
  const rule = SPECIES_RULES[id];
  const scores = state.scores?.[id] || [];
  const now = Date.now();
  const wx = state.weather?.hourly?.length ? weather.interp(state.weather.hourly, now) : null;
  const pos = state.fix || spots.getPort();
  const body = el('div');

  const reg = getRegulationStatus(id, now);
  if (reg.mode !== 'open') {
    body.append(el('div', `banner ${reg.mode === 'closed' ? 'danger' : 'warn'}`,
      `${reg.mode === 'closed' ? 'Fermé' : 'No-kill'} — ${reg.period.note}`));
  }

  body.append(el('p', 'muted', rule.playbook));
  body.append(el('p', 'tiny', `${rule.scientificName} · dérive confortable ${rule.comfortableDriftKn[0]}–${rule.comfortableDriftKn[1]} nd · ${rule.depthRangeM[0]}–${rule.depthRangeM[1]} m`));

  /* --- Fenêtres --- */
  const windows = findWindows(scores).filter((w) => w.endT > now).slice(0, 3);
  body.append(el('div', 'hr'));
  body.append(el('div', 'list-title', 'Meilleures fenêtres'));
  if (!windows.length) {
    body.append(el('p', 'muted', 'Aucune fenêtre exploitable sur la période calculée.'));
  } else {
    for (const w of windows) {
      const r = el('div', 'row');
      r.style.padding = '5px 0';
      r.append(el('span', 'tnum', `${fmt.hhmmDay(w.startT, now)} – ${fmt.hhmm(w.endT)}`));
      r.append(el('span', 'tiny', `pic ${w.peakScore} à ${fmt.hhmm(w.peakT)}`));
      r.append(el('div', 'spacer'), scoreBadge(w.peakScore));
      body.append(r);
    }
  }

  /* --- Facteurs au pic --- */
  const peak = windows[0]
    ? scores.find((s) => s.t === windows[0].peakT)
    : scores.reduce((a, b) => (Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a), scores[0]);
  if (peak) {
    body.append(el('div', 'hr'));
    body.append(el('div', 'list-title', windows[0] ? 'Détail au pic' : 'Détail maintenant'));
    body.append(factorBars(peak.breakdown));
    if (peak.coverage != null && peak.coverage < 0.85) {
      body.append(el('p', 'tiny', `Score calculé sur ${Math.round(peak.coverage * 100)} % des facteurs — données manquantes (météo hors ligne ?).`));
    }
  }

  /* --- Postes --- */
  body.append(el('div', 'hr'));
  body.append(el('div', 'list-title', 'Où aller'));
  const best = spots.bestSpots(id, windows[0]?.peakT ?? now, wx, pos, 4);
  for (const b of best) {
    const item = el('button', 'list-item');
    item.type = 'button';
    const main = el('div', 'list-main');
    const t = el('div', 'list-title', b.spot.name);
    if (b.spot.seed) t.append(el('span', 'tag tag-seed', ' à recaler'));
    main.append(t);
    main.append(el('div', 'list-sub', [
      b.distanceM != null ? `${fmt.dist(b.distanceM)} au ${fmt.heading(b.bearingDeg)}` : null,
      ...b.reasons.slice(0, 2),
    ].filter(Boolean).join(' · ')));
    item.append(main, scoreBadge(b.score));
    item.addEventListener('click', () => {
      set({ waypoint: { lat: b.spot.lat, lon: b.spot.lon, name: b.spot.name } });
      closeSheet();
      emit('goto', 'map');
      toast(`Route sur ${b.spot.name}`, 'good');
    });
    body.append(item);
  }

  /* --- Technique --- */
  const turb = state.weather?.hourly?.length ? weather.turbidity(state.weather.hourly, now, tide.coefficient(now)) : null;
  const murky = turb != null && turb > 0.45;
  body.append(el('div', 'hr'));
  body.append(el('div', 'list-title', `Technique${turb != null ? ` — eau ${murky ? 'brassée' : 'claire'}` : ''}`));
  body.append(el('p', 'muted', murky ? rule.technique.murky : rule.technique.clear));
  const lures = el('div', 'row wrap');
  for (const l of rule.technique.lures) lures.append(el('span', 'chip', l));
  body.append(lures);

  /* --- Réglementation --- */
  body.append(el('div', 'hr'));
  body.append(el('div', 'list-title', 'Réglementation'));
  const rl = el('ul', 'tiny');
  rl.style.paddingLeft = '16px';
  const R = rule.regulation;
  if (R.minSizeCm) rl.append(el('li', null, `Taille minimale : ${R.minSizeCm} cm`));
  if (R.dailyBag) rl.append(el('li', null, `Quota : ${R.dailyBag} par jour et par personne`));
  if (R.markingRequired) rl.append(el('li', null, 'Marquage obligatoire'));
  if (R.declarationRequired) rl.append(el('li', null, 'Déclaration de capture requise'));
  for (const p of R.closedPeriods) rl.append(el('li', null, `${p.from} → ${p.to} : ${p.mode === 'closed' ? 'fermeture' : 'no-kill'} — ${p.note}`));
  for (const n of R.notes || []) rl.append(el('li', null, n));
  rl.append(el('li', null, `${R.zone} · source ${R.sourceYear} · vérifié le ${R.lastCheckedISO}`));
  body.append(rl);

  const logBtn = button(`🎣 J’ai pris un ${rule.name.toLowerCase()}`, 'btn-lime btn-lg', async () => {
    closeSheet();
    await record.record(id);
  });
  logBtn.style.marginTop = '12px';
  body.append(logBtn);

  openSheet(`${rule.emoji} ${rule.name}`, body);
}

/* ==========================================================================
 * Détail d'une case (espèce × heure)
 * ========================================================================== */
function showMoment(id, score, sample) {
  const rule = SPECIES_RULES[id];
  const body = el('div');

  const top = el('div', 'row');
  top.append(scoreBadge(score.score));
  const info = el('div', 'list-main');
  info.append(el('div', 'list-title', fmt.hhmm(sample.t)));
  info.append(el('div', 'list-sub', `${rule.name} · coef ${sample.coefficient} · ${senseLabel(sample.tideSense)}`));
  top.append(info);
  body.append(top);

  body.append(el('div', 'hr'));
  const strip = el('div', 'strip');
  const p = (v, l) => {
    const n = el('div', 'pill');
    n.append(el('div', 'pill-val', v), el('div', 'pill-lbl', l));
    return n;
  };
  strip.append(p(`${fmt.num(sample.heightM, 1)} m`, 'HAUTEUR'));
  strip.append(p(`${fmt.num(sample.driftKn, 1)} nd`, 'DÉRIVE'));
  strip.append(p(fmt.cardinal(sample.driftDirDeg), 'VERS'));
  if (sample.windSpeedKn != null) strip.append(p(`${Math.round(sample.windSpeedKn)} nd`, `VENT ${fmt.cardinal(sample.windDirDeg)}`));
  if (sample.waveHeightM != null) strip.append(p(`${fmt.num(sample.waveHeightM, 1)} m`, 'MER'));
  if (sample.seaTempC != null) strip.append(p(`${fmt.num(sample.seaTempC, 1)}°`, 'EAU'));
  strip.append(p(lightLabel(sample.lightPhase), 'LUMIÈRE'));
  body.append(strip);

  body.append(el('div', 'hr'));
  if (score.drivingFactor) {
    body.append(el('p', 'muted', `✅ Ce qui porte : ${score.drivingFactor.label.toLowerCase()} (${Math.round(score.drivingFactor.value * 100)} %).`));
  }
  if (score.limitingFactor && score.limitingFactor.value < 0.7) {
    body.append(el('p', 'muted', `⚠️ Ce qui freine : ${score.limitingFactor.label.toLowerCase()} (${Math.round(score.limitingFactor.value * 100)} %).`));
  }
  body.append(factorBars(score.breakdown));

  body.append(el('div', 'hr'));
  body.append(button(`Voir la fiche ${rule.name}`, 'btn-primary btn-lg', () => {
    closeSheet();
    setTimeout(() => showSpecies(id), 60);
  }));

  openSheet(`${rule.emoji} ${rule.name} — ${fmt.hhmm(sample.t)}`, body);
}

const senseLabel = (s) => (s === 'flood' ? 'montant' : s === 'ebb' ? 'descendant' : 'étale');
const lightLabel = (l) => ({ night: 'Nuit', twilight: 'Crépuscule', day: 'Jour' }[l] || l);

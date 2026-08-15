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
import { el, clear, card, button, toast, openSheet, closeSheet, collapsible, noteBanner, heatColor, scoreBadge, factorBars } from '../ui/dom.js';
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
import { startNav } from '../ui/destination.js';
import * as lurebox from '../ui/lurebox.js';

/** Fenêtres du plan visibles sans ouvrir la feuille. */
const PLAN_VISIBLE = 3;

let root;
let unsub;
let refs = {};
let dayOffset = 0;

export function mount(container) {
  root = clear(container);

  refs.head = el('div', 'card');
  refs.warn = el('div');
  refs.cond = el('div', 'card tight');
  refs.lure = el('div');
  refs.plan = el('div');
  refs.grid = el('div');
  refs.foot = el('div', 'tiny');

  /* La grille est l'outil de celui qui veut se faire son propre avis : précieux,
   * mais jamais ce qu'on regarde en premier. Repliée, elle rend au plan les
   * 470 px qu'elle lui prenait. */
  const gridFold = collapsible('ESPÈCES × HEURES', refs.grid, { hint: 'la journée en un coup d’œil' });

  root.append(refs.head, refs.warn, refs.cond, refs.lure, refs.plan, gridFold, refs.foot);

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

  /* ---- Verdict -----------------------------------------------------------
   * Deux lignes, rien d'autre. Le sélecteur de jour a longtemps vécu ici, en
   * haut d'écran, en grand — alors qu'il ne pilote QUE le tableau horaire :
   * une commande bien en vue qui ne fait pas ce qu'elle a l'air de faire.
   * Il est descendu contre le tableau qu'il commande. Le catalogue, lui, se
   * consulte à la maison, pas au moment de décider où mouiller : il rejoint
   * le pied de page. */
  const head = clear(refs.head);
  if (!a || !scores) {
    head.append(el('div', 'muted', 'Calcul en cours…'));
    return;
  }
  head.append(el('h2', 'list-title', a.headline));
  head.append(el('div', 'list-sub', a.subline));

  /* ---- Avertissements ---------------------------------------------------
   * Tout ne mérite pas un encadré. « Pas de météo à jour » est un défaut de
   * donnée : c'est un avertissement, il reste en encadré. « Coefficient 101 :
   * dérive rapide, plombées lourdes » est un CONSEIL DE PÊCHE déguisé en
   * alerte — sa place est sous les conditions qu'il commente. Empilés, les
   * deux repoussaient le plan sous la ligne de flottaison de l'écran. */
  const notes = a.warnings || [];
  const warn = clear(refs.warn);
  for (const w of notes.filter((w) => w.level !== 'info')) warn.append(noteBanner(w.text, w.level));

  /* ---- Conditions ------------------------------------------------------- */
  const cond = clear(refs.cond);
  const strip = el('div', 'strip');
  for (const c of a.conditions || []) {
    const p = el('div', 'pill');
    p.style.minWidth = '84px';
    p.append(el('div', 'pill-val', c.value), el('div', 'pill-lbl', c.label));
    strip.append(p);
  }
  const stripWrap = el('div', 'strip-wrap');
  stripWrap.append(strip);
  cond.append(stripWrap);
  for (const w of notes.filter((w) => w.level === 'info')) {
    const line = el('div', 'cond-note', w.text);
    cond.append(line);
  }

  /* ---- Boîte à leurres ---------------------------------------------------
   * Juste sous les conditions et juste au-dessus du plan, parce que c'est
   * exactement l'ordre des questions : quel temps il fait, avec quoi je pêche,
   * et où je vais. Le bar est l'espèce n°1 du secteur et « je mets quoi » est
   * la question la plus posée d'un bateau — elle mérite d'être sur le chemin,
   * pas dans un menu. */
  clear(refs.lure).append(lurebox.card());

  /* ---- Plan ------------------------------------------------------------- */
  const plan = clear(refs.plan);
  const planCard = el('div', 'card');
  const ph = el('div', 'card-head');
  ph.append(el('h3', null, 'PLAN DE SORTIE'));
  planCard.append(ph);

  if (!a.plan?.length) {
    planCard.append(el('div', 'empty', 'Aucune fenêtre exploitable dans les 14 prochaines heures.'));
  } else {
    /* Le moteur sort volontiers six à huit fenêtres : au-delà de la troisième
     * on ne planifie plus, on lit un tableau. Les trois premières tiennent
     * dans l'écran, le reste part dans une feuille. */
    for (const p of a.plan.slice(0, PLAN_VISIBLE)) planCard.append(planItem(p));
    const rest = a.plan.slice(PLAN_VISIBLE);
    if (rest.length) {
      const more = button(`Voir les ${rest.length} autres fenêtres`, 'btn-sm btn-ghost', () => {
        const body = el('div');
        for (const p of a.plan) body.append(planItem(p));
        openSheet('Plan de sortie', body);
      });
      more.style.marginTop = '4px';
      planCard.append(more);
    }
  }
  plan.append(planCard);

  /* ---- Grille ----------------------------------------------------------- */
  renderGrid(scores, samples);

  /* ---- Pied ------------------------------------------------------------- */
  const foot = clear(refs.foot);
  const bookBtn = button(`📖 Les ${catalog.count()} espèces des côtes normandes`, 'btn-sm', () => openSpeciesBook());
  bookBtn.style.marginBottom = '12px';
  foot.append(bookBtn);
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

/** Une fenêtre du plan : deux lignes, un score, le reste au tap. */
function planItem(p) {
  const item = el('button', 'list-item plan-item');
  item.type = 'button';

  const main = el('div', 'list-main');
  main.append(el('div', 'list-title', `${SPECIES_RULES[p.speciesId].emoji} ${p.title}`));
  for (const line of p.lines) main.append(el('div', 'list-sub', line));
  item.append(main, scoreBadge(p.score));
  item.addEventListener('click', () => showWindow(p));
  return item;
}

/**
 * Le détail d'une fenêtre. Ce qu'on veut ici, dans l'ordre : pourquoi cette
 * heure-là, puis y aller, puis tout savoir de l'espèce — et la fiche espèce
 * s'empile par-dessus, avec le bouton retour, pour ne pas perdre le plan.
 */
function showWindow(p) {
  const body = el('div');
  const rule = SPECIES_RULES[p.speciesId];

  const hero = el('div', 'row');
  const heroMain = el('div', 'list-main');
  heroMain.append(el('div', 'list-title', `${rule.emoji} ${p.title}`));
  hero.append(heroMain, scoreBadge(p.score));
  body.append(hero);

  for (const line of [...p.lines, ...(p.notes || [])]) {
    const l = el('div', 'list-sub', line);
    l.style.padding = '5px 0';
    body.append(l);
  }

  if (p.spot?.spot?.lat != null) {
    const go = button(`🧭 Naviguer vers ${p.spot.spot.name}`, 'btn-primary btn-lg', () => {
      // startNav referme la feuille lui-même.
      startNav({ lat: p.spot.spot.lat, lon: p.spot.spot.lon, name: p.spot.spot.name, kind: 'spot' });
    });
    go.style.marginTop = '12px';
    body.append(go);
  }

  const more = button(`📖 Fiche ${rule.name}`, 'btn-sm', () => showSpecies(p.speciesId));
  more.style.marginTop = '8px';
  body.append(more);

  openSheet('Fenêtre de pêche', body);
}

function renderGrid(scores, samples) {
  const box = clear(refs.grid);    // le titre est porté par le repli

  // Le sélecteur de jour vit ici : c'est le seul contenu qu'il change.
  const seg = el('div', 'seg');
  ['Aujourd’hui', 'Demain', 'J+2'].forEach((label, i) => {
    const b = el('button', dayOffset === i ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      dayOffset = i;
      render();
    });
    seg.append(b);
  });
  box.append(seg);
  box.append(el('div', 'tiny', 'Touche une case pour le détail de l’heure.'));

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

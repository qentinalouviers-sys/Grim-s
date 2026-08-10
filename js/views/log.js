/* ==========================================================================
 * views/log.js — JOURNAL, réglages et calibration
 * --------------------------------------------------------------------------
 * L'écran où l'app rend des comptes : ce qu'elle a appris, sur quelles
 * données, et avec quelle marge d'erreur. Un modèle qui s'ajuste sans dire
 * de combien fabrique de la fausse confiance — le pire défaut possible pour
 * un outil qu'on emmène en mer.
 * ========================================================================== */

import { state, set, on, emit } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from '../ui/dom.js';
import * as fmt from '../core/fmt.js';
import * as learning from '../fishing/learning.js';
import * as spots from '../fishing/spots.js';
import * as stream from '../data/stream.js';
import * as tide from '../data/tide.js';
import * as idb from '../core/idb.js';
import { SPECIES_RULES } from '../fishing/species.js';
import { catchForm } from './fish.js';

let root;
let refs = {};

export function mount(container) {
  root = clear(container);
  refs.body = el('div');
  root.append(refs.body);
  render();
}

export function unmount() {
  refs = {};
}

on('catches:changed', () => refs.body && render());

async function render() {
  const box = clear(refs.body);

  /* ══ Ce que le modèle a appris ═══════════════════════════════════════ */
  const learnCard = el('div', 'card');
  const lh = el('div', 'card-head');
  lh.append(el('h3', null, 'CE QUE LE MODÈLE A APPRIS'));
  learnCard.append(lh);
  for (const item of learning.explain()) {
    const r = el('div');
    r.style.padding = '5px 0';
    r.append(el('div', 'list-title', item.title));
    r.append(el('div', 'list-sub', item.text));
    learnCard.append(r);
  }
  box.append(learnCard);

  /* ══ Journal de captures ═════════════════════════════════════════════ */
  const list = (await learning.catches()).sort((a, b) => b.t - a.t);
  const catchCard = el('div', 'card flush');
  const ch = el('div', 'card-head');
  ch.style.padding = '12px 12px 0';
  ch.append(el('h3', null, `PRISES (${list.length})`), el('div', 'spacer'));
  const add = button('＋', 'btn-sm', () => catchForm());
  ch.append(add);
  catchCard.append(ch);

  if (!list.length) {
    catchCard.append(el('div', 'empty', 'Rien encore. Chaque prise notée affine le modèle pour tes spots.'));
  } else {
    const l = el('div', 'list');
    for (const c of list.slice(0, 40)) {
      const item = el('button', 'list-item');
      item.type = 'button';
      const main = el('div', 'list-main');
      const rule = SPECIES_RULES[c.speciesId];
      main.append(el('div', 'list-title',
        `${rule?.emoji || '🐟'} ${rule?.name || 'Autre'}${c.lengthCm ? ` · ${c.lengthCm} cm` : ''}${c.count > 1 ? ` ×${c.count}` : ''}`));
      main.append(el('div', 'list-sub', [
        new Date(c.t).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
        c.released ? 'relâché' : null,
        c.snapshot ? `coef ${c.snapshot.coefficient}` : null,
        c.snapshot ? `dérive ${fmt.num(c.snapshot.driftKn, 1)} nd` : null,
        c.note || null,
      ].filter(Boolean).join(' · ')));
      item.append(main);
      if (Number.isFinite(c.predictedScore)) {
        const b = el('div', 'list-right');
        b.append(el('div', 'tnum', String(c.predictedScore)));
        b.append(el('div', 'tiny', 'prédit'));
        item.append(b);
      }
      item.addEventListener('click', () => showCatch(c));
      l.append(item);
    }
    catchCard.append(l);
  }
  box.append(catchCard);

  /* ══ Marques ═════════════════════════════════════════════════════════ */
  const personal = spots.personalSpots();
  const spotCard = el('div', 'card flush');
  const sh = el('div', 'card-head');
  sh.style.padding = '12px 12px 0';
  sh.append(el('h3', null, `MES MARQUES (${personal.length})`), el('div', 'spacer'));
  const imp = button('Importer GPX', 'btn-sm', importGPX);
  sh.append(imp);
  spotCard.append(sh);
  if (!personal.length) {
    spotCard.append(el('div', 'empty', 'Aucune marque personnelle. Utilise « 📍 » en mode Carte, ou importe un GPX.'));
  } else {
    const l = el('div', 'list');
    for (const s of personal) {
      const item = el('div', 'list-item');
      const main = el('div', 'list-main');
      main.append(el('div', 'list-title', s.name));
      main.append(el('div', 'list-sub', `${fmt.latDDM(s.lat)} ${fmt.lonDDM(s.lon)}${
        s.habitat?.length ? ` · ${s.habitat.join(', ')}` : ''}`));
      item.append(main);
      item.append(button('✕', 'btn-sm btn-ghost', async () => {
        await spots.removeSpot(s.id);
        emit('spots:changed');
        render();
      }));
      l.append(item);
    }
    spotCard.append(l);
  }
  box.append(spotCard);

  /* ══ Calibration ═════════════════════════════════════════════════════ */
  box.append(calibrationCard());

  /* ══ Réglages ════════════════════════════════════════════════════════ */
  box.append(await settingsCard());

  /* ══ Sources et mentions ═════════════════════════════════════════════ */
  box.append(aboutCard());
}

/* ==========================================================================
 * Calibration du modèle de dérive
 * ========================================================================== */
function calibrationCard() {
  const cfg = stream.config();
  const c = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'MODÈLE DE DÉRIVE'), el('div', 'spacer'));
  head.append(el('span', `chip ${cfg.calibrated ? 'good' : 'warn'}`, cfg.calibrated ? 'calibré' : 'valeurs par défaut'));
  c.append(head);

  c.append(el('p', 'muted',
    "La dérive prédite vaut ce que valent trois paramètres : l'échelle courant/marée, l'axe du flot et du jusant, et le déphasage entre l'étale de hauteur et l'étale de courant. Aucun des trois ne se devine — ils se mesurent, sur TON bateau."));

  const rows = [
    ['Échelle', `${cfg.knPerMPerHour} nd par m/h`],
    ['Axe du flot', `${cfg.floodAxisDeg}°`],
    ['Axe du jusant', `${cfg.ebbAxisDeg}°`],
    ['Déphasage étale', `${cfg.slackLagMin > 0 ? '+' : ''}${cfg.slackLagMin} min`],
    ['Fardage', `${cfg.leewayPct} % du vent`],
    ['Incertitude', `±${cfg.uncertaintyPct} %`],
    ['Relevés', String(cfg.observations || 0)],
  ];
  for (const [k, v] of rows) {
    const r = el('div', 'row');
    r.style.justifyContent = 'space-between';
    r.style.padding = '3px 0';
    r.append(el('span', 'tiny', k), el('span', 'tnum', v));
    r.lastChild.style.fontSize = '13px';
    c.append(r);
  }

  c.append(el('p', 'tiny',
    'Comment relever : moteur coupé, dérive libre pendant 30 secondes au moins, puis « ⏱ Relever » en mode Carte. Varie les coefficients et les moments de marée. Cinq relevés suffisent à démarrer, vingt donnent un modèle propre.'));

  const acts = el('div', 'btn-row');
  acts.append(
    button('Ajuster le fardage', '', leewayForm),
    button('Réinitialiser', 'btn-ghost', async () => {
      stream.setConfig({ ...stream.DEFAULTS });
      await idb.del('kv', 'driftCalibration');
      await idb.del('kv', 'driftObs');
      toast('Modèle de dérive réinitialisé');
      render();
    }),
  );
  c.append(acts);
  return c;
}

function leewayForm() {
  const cfg = stream.config();
  const body = el('div');
  body.append(el('p', 'muted',
    "Part de la vitesse du vent que le bateau prend en dérive, en travers. Un open ponté avec un haut franc-bord dérive plus qu'un bateau bas sur l'eau : 2 % pour une coque très fine, 3–4 % pour un open de pêche classique, 5–6 % pour un bateau à cabine haute."));

  const f = el('div', 'field');
  f.append(el('label', null, 'Fardage (% du vent)'));
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.5';
  input.min = '0';
  input.max = '10';
  input.value = String(cfg.leewayPct);
  input.inputMode = 'decimal';
  f.append(input);
  body.append(f);

  body.append(button('Appliquer', 'btn-primary btn-lg', async () => {
    const v = Math.max(0, Math.min(10, Number(input.value) || 3.5));
    const next = stream.setConfig({ leewayPct: v });
    await idb.put('kv', 'driftCalibration', next);
    closeSheet();
    toast(`Fardage réglé à ${v} %`, 'good');
    render();
  }));
  openSheet('Fardage du bateau', body);
}

/* ==========================================================================
 * Réglages
 * ========================================================================== */
async function settingsCard() {
  const c = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'RÉGLAGES & DONNÉES'));
  c.append(head);

  const info = tide.info();
  const src = el('div', 'row');
  src.style.justifyContent = 'space-between';
  src.append(el('span', 'tiny', 'Source de marée'), el('span', `chip ${info.trust === 'high' ? 'good' : info.trust === 'low' ? 'warn' : ''}`, info.label));
  c.append(src);
  c.append(el('p', 'tiny', info.detail));

  const q = await idb.quota();
  const tiles = await idb.count('tiles');
  c.append(el('p', 'tiny',
    `${tiles} tuiles de carte en cache${q ? ` · ${(q.usage / 1e6).toFixed(0)} Mo utilisés sur ${(q.quota / 1e6).toFixed(0)} Mo` : ''}.`));

  const acts1 = el('div', 'btn-row');
  acts1.append(
    button('🔄 Rafraîchir les données', '', () => {
      emit('data:refresh', { force: true });
      toast('Actualisation…');
    }),
    button('🗑 Vider les tuiles', 'btn-ghost', async () => {
      await idb.clear('tiles');
      toast('Cache de tuiles vidé');
      render();
    }),
  );
  c.append(acts1);

  const acts2 = el('div', 'btn-row');
  acts2.style.marginTop = '8px';
  acts2.append(
    button('📤 Exporter mes données', '', exportData),
    button('📥 Importer', '', importData),
  );
  c.append(acts2);

  const night = el('div', 'btn-row');
  night.style.marginTop = '8px';
  night.append(button(state.nightMode ? '☀️ Mode jour' : '🌙 Mode nuit', '', () => {
    set({ nightMode: !state.nightMode });
    render();
  }));
  c.append(night);

  return c;
}

/* ==========================================================================
 * Import / export
 * ========================================================================== */
async function exportData() {
  const data = await learning.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `grims-compagnon-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Export généré', 'good');
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await learning.importAll(JSON.parse(await file.text()));
      toast('Données importées', 'good');
      emit('spots:changed');
      render();
    } catch (e) {
      toast(`Import impossible : ${e.message}`, 'danger');
    }
  });
  input.click();
}

function importGPX() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gpx,application/gpx+xml,application/xml,text/xml';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const n = await spots.importGPX(await file.text());
      toast(`${n} marque(s) importée(s)`, 'good');
      emit('spots:changed');
      render();
    } catch (e) {
      toast(`GPX illisible : ${e.message}`, 'danger');
    }
  });
  input.click();
}

/* ==========================================================================
 * Détail d'une prise
 * ========================================================================== */
function showCatch(c) {
  const rule = SPECIES_RULES[c.speciesId];
  const body = el('div');
  body.append(el('p', 'muted', new Date(c.t).toLocaleString('fr-FR')));
  if (c.note) body.append(el('p', null, c.note));

  if (c.snapshot) {
    const strip = el('div', 'strip');
    const p = (v, l) => {
      const n = el('div', 'pill');
      n.append(el('div', 'pill-val', v), el('div', 'pill-lbl', l));
      return n;
    };
    const s = c.snapshot;
    strip.append(p(String(s.coefficient), 'COEF'));
    strip.append(p(`${fmt.num(s.heightM, 1)} m`, 'HAUTEUR'));
    strip.append(p(`${fmt.num(s.driftKn, 1)} nd`, 'DÉRIVE'));
    strip.append(p(s.tideSense === 'flood' ? 'Montant' : s.tideSense === 'ebb' ? 'Descendant' : 'Étale', 'MARÉE'));
    strip.append(p(`${s.hoursFromHW > 0 ? '+' : ''}${fmt.num(s.hoursFromHW, 1)} h`, 'DE LA PM'));
    if (s.seaTempC != null) strip.append(p(`${fmt.num(s.seaTempC, 1)}°`, 'EAU'));
    if (s.windSpeedKn != null) strip.append(p(`${Math.round(s.windSpeedKn)} nd`, 'VENT'));
    body.append(strip);
  }

  if (Number.isFinite(c.predictedScore)) {
    body.append(el('div', 'hr'));
    body.append(el('p', 'muted', `Le modèle donnait ${c.predictedScore}/100 pour ${rule?.name || 'cette espèce'} à ce moment-là.`));
  }

  body.append(el('div', 'hr'));
  body.append(button('Supprimer cette prise', 'btn-ghost btn-lg', async () => {
    await learning.removeCatch(c.id);
    closeSheet();
    render();
    toast('Prise supprimée');
  }));

  openSheet(rule?.name || 'Prise', body);
}

/* ==========================================================================
 * À propos
 * ========================================================================== */
function aboutCard() {
  const c = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', null, 'SOURCES & LIMITES'));
  c.append(head);

  const rows = [
    ['Marée', 'SHOM (vignette officielle Dieppe) + modèle harmonique 23 constituants ajusté sur cette série. Calcul embarqué, fonctionne hors réseau, horizon illimité.'],
    ['Vent, pression, visibilité', 'Open-Meteo Forecast — gratuit, sans clé.'],
    ['Mer, houle, température, courant résiduel', 'Open-Meteo Marine.'],
    ['Soleil et lune', 'Calculés à bord (NOAA / série lunaire tronquée). Aucun réseau.'],
    ['Courant de marée', 'Modèle local dérivé de dh/dt, axes flot/jusant du secteur, calibrable sur relevés GPS. Ce n’est PAS un modèle hydrodynamique.'],
    ['Carte', 'OpenStreetMap + balisage OpenSeaMap, tuiles mises en cache localement.'],
    ['Scoring pêche', 'Poids issus de la littérature halieutique Manche. Opinions structurées, pas un modèle validé — d’où le journal de captures qui les réajuste.'],
  ];
  for (const [k, v] of rows) {
    const r = el('div');
    r.style.padding = '5px 0';
    r.append(el('div', 'list-title', k));
    r.append(el('div', 'list-sub', v));
    c.append(r);
  }

  const warn = el('div', 'banner warn');
  warn.style.marginTop = '10px';
  warn.append(el('span', null,
    'Cette application est une aide à la décision. Elle ne remplace ni les documents nautiques officiels, ni les bulletins météo marine, ni ton jugement. Vérifie la réglementation auprès de la DIRM Manche Est – Mer du Nord.'));
  c.append(warn);

  c.append(el('p', 'tiny', 'Aucun compte, aucun serveur, aucune télémétrie. Tout reste sur cet appareil.'));
  return c;
}

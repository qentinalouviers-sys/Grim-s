/* ==========================================================================
 * ui/speciesbook.js — le livre des espèces
 * --------------------------------------------------------------------------
 * Deux usages, un seul écran, et c'est volontaire :
 *
 *   CONSULTER  « qu'est-ce que c'est que ce poisson, et je peux le garder ? »
 *   CHOISIR    au moment d'enregistrer une prise, quand l'espèce n'est pas
 *              dans les sept tuiles du carnet rapide.
 *
 * Deux écrans séparés auraient divergé au premier ajout d'espèce, et surtout
 * le pêcheur aurait dû apprendre deux endroits pour la même chose.
 *
 * L'ordre par défaut est celui de la SAISON, pas l'alphabet : à la fin août on
 * veut voir maquereau, bar et seiche, pas anchois et araignée. L'alphabet est
 * un ordre pour les dictionnaires, pas pour les sorties.
 * ========================================================================== */

import { el, clear, button, chip, openSheet, closeSheet, toast } from './dom.js';
import * as catalog from '../fishing/catalog.js';
import { SPECIES_RULES, getRegulationStatus } from '../fishing/species.js';

/**
 * @param {{ onPick?:(species)=>void, title?:string }} [opts]
 *   onPick — mode sélection : la fiche propose « enregistrer cette prise ».
 */
export function openSpeciesBook(opts = {}) {
  const body = el('div');
  const state = { query: '', group: null };

  /* ---- En-tête collant : recherche + filtres ---------------------------- *
   * Il reste en haut quand la liste défile. Avant, filtrer au milieu de
   * soixante espèces obligeait à remonter tout en haut de la feuille. */
  const sticky = el('div', 'sheet-sticky');
  const field = el('div', 'field');
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Chercher : nom, surnom, nom latin…';
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  field.append(input);
  sticky.append(field);

  /* ---- Filtres par groupe, sur UNE ligne qui défile --------------------- */
  const filters = el('div', 'filter-row');
  const chips = new Map();
  const mkFilter = (id, label) => {
    const b = el('button', 'chip chip-btn', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.group = state.group === id || id === null ? null : id;
      paintFilters();
      paint();
      // On remonte en haut de liste : après un changement de filtre, rester à
      // la même hauteur de défilement affiche un morceau arbitraire.
      document.getElementById('sheet-body').scrollTop = 0;
    });
    chips.set(id, b);
    filters.append(b);
  };
  mkFilter(null, 'Toutes');
  mkFilter('saison', '⏱ De saison');
  for (const g of catalog.GROUPS) mkFilter(g.id, `${g.emoji} ${g.name.replace(/^Poissons /, '')}`);
  const paintFilters = () => {
    for (const [id, b] of chips) b.classList.toggle('good', state.group === id);
  };
  sticky.append(filters);

  const countLine = el('div', 'tiny');
  countLine.style.padding = '4px 0 0';
  sticky.append(countLine);
  body.append(sticky);

  const list = el('div', 'card flush');
  list.style.marginTop = '2px';
  body.append(list);

  body.append(el('p', 'tiny',
    `${catalog.count()} espèces recensées pour les côtes normandes — zone ${catalog.META.zone}. `
    + `Tailles réglementaires vérifiées le ${catalog.META.checked} : elles périment, et cette liste `
    + `ne remplace pas l’arrêté en vigueur. Quand une maille n’est pas garantie, la fiche le dit au lieu d’inventer un chiffre.`));

  function paint() {
    const now = Date.now();
    let rows = catalog.search(state.query);
    if (state.group === 'saison') {
      rows = rows.filter((s) => s.status !== 'forbidden' && catalog.seasonAt(s, now) !== 'off');
    } else if (state.group) {
      rows = rows.filter((s) => s.group === state.group);
    }
    // Saison d'abord, puis les interdits en dernier : ce qu'on peut pêcher
    // maintenant doit être en haut de l'écran, pas en bas d'une liste de 60.
    rows = [...rows].sort((a, b) => rank(a, now) - rank(b, now) || a.name.localeCompare(b.name, 'fr'));

    clear(list);
    countLine.textContent = state.query || state.group
      ? `${rows.length} espèce${rows.length > 1 ? 's' : ''} sur ${catalog.count()}`
      : `${catalog.count()} espèces des côtes normandes`;
    if (!rows.length) {
      list.append(el('div', 'empty', 'Rien sous ce nom. Essaie le nom local, ou le nom latin.'));
      return;
    }
    /* Sections : soixante lignes d'affilée ne se parcourent pas, elles se
       subissent. Le titre colle sous l'en-tête, donc on sait toujours dans
       quelle famille on se trouve. */
    let section = null;
    for (const sp of rows) {
      const label = sectionOf(sp, now);
      if (label !== section) {
        section = label;
        list.append(el('div', 'list-section', label));
      }
      list.append(row(sp, now, opts));
    }
  }

  input.addEventListener('input', () => {
    state.query = input.value;
    paint();
  });

  paintFilters();
  paint();
  return openSheet(opts.title || 'Les espèces', body);
}

/** Intitulé de la section d'une espèce, dans l'ordre du tri. */
function sectionOf(sp, now) {
  if (sp.status === 'forbidden') return 'À relâcher — interdits';
  const season = catalog.seasonAt(sp, now);
  if (season === 'peak') return 'Pleine saison en ce moment';
  if (season === 'present') return 'Présentes en ce moment';
  return 'Hors saison';
}

/** De saison en premier, interdits en dernier. */
function rank(s, now) {
  if (s.status === 'forbidden') return 9;
  const season = catalog.seasonAt(s, now);
  return season === 'peak' ? 0 : season === 'present' ? 1 : 5;
}

function row(s, now, opts) {
  const b = el('button', 'list-item');
  b.type = 'button';

  const badge = el('div', 'score-badge');
  badge.style.background = s.color;
  badge.style.color = '#050b14';
  badge.style.fontSize = '17px';
  badge.textContent = s.emoji;
  b.append(badge);

  const main = el('div', 'list-main');
  const title = el('div', 'list-title', s.name);
  const season = catalog.seasonAt(s, now);
  if (s.status === 'forbidden') title.append(tag('interdit', 'tag-closed'));
  else if (s.status === 'restricted') title.append(tag('encadré', 'tag-nokill'));
  else if (season === 'peak') title.append(tag('pleine saison', 'tag-info'));
  if (s.scored) title.append(tag('scoré', 'tag-seed'));
  main.append(title);

  main.append(el('div', 'list-sub', [
    s.sci,
    s.minSizeCm != null ? `maille ${fmtSize(s)}` : s.status === 'forbidden' ? null : 'maille à vérifier',
  ].filter(Boolean).join(' · ')));
  b.append(main);
  b.append(el('div', 'list-right', '›'));

  b.addEventListener('click', () => openSheetFor(s, opts));
  return b;
}

const tag = (txt, cls) => {
  const t = el('span', `tag ${cls}`, txt);
  t.style.marginLeft = '6px';
  return t;
};

const fmtSize = (s) => `${String(s.minSizeCm).replace('.', ',')} cm${s.measure ? ` (${s.measure})` : ''}`;

/* --------------------------------------------------------------------------
 * Fiche
 * ------------------------------------------------------------------------ */
export function openSheetFor(s, opts = {}) {
  const body = el('div');
  const now = Date.now();

  const head = el('div', 'row');
  const badge = el('div', 'score-badge');
  badge.style.background = s.color;
  badge.style.color = '#050b14';
  badge.style.fontSize = '22px';
  badge.style.minWidth = '54px';
  badge.style.height = '44px';
  badge.textContent = s.emoji;
  const main = el('div', 'list-main');
  main.append(el('div', 'list-title', s.name));
  main.append(el('div', 'list-sub', s.sci + (s.alt.length ? ` · aussi « ${s.alt.join(' », « ')} »` : '')));
  head.append(badge, main);
  body.append(head);

  /* ---- Danger d'abord : c'est ce qui envoie à l'hôpital ----------------- */
  if (s.caution) body.append(el('div', 'banner danger', s.caution));
  if (s.status === 'forbidden') {
    body.append(el('div', 'banner danger', `Capture interdite. ${s.note || ''}`.trim()));
  } else if (s.status === 'restricted') {
    body.append(el('div', 'banner warn', s.note || 'Espèce sous restriction : vérifier l’arrêté avant de conserver.'));
  }

  /* ---- Pastilles -------------------------------------------------------- */
  const strip = el('div', 'strip');
  strip.style.marginTop = '8px';
  const pill = (v, l) => {
    const p = el('div', 'pill');
    p.append(el('div', 'pill-val', v), el('div', 'pill-lbl', l));
    strip.append(p);
  };
  pill(s.minSizeCm != null ? `${String(s.minSizeCm).replace('.', ',')} cm` : '?', 'MAILLE');
  if (s.bag) pill(String(s.bag), 'PAR JOUR');
  if (s.depthM) pill(`${s.depthM[0]}–${s.depthM[1]} m`, 'SONDE');
  const season = catalog.seasonAt(s, now);
  pill(season === 'peak' ? 'Pic' : season === 'present' ? 'Oui' : 'Hors', 'SAISON');
  body.append(strip);

  if (s.measure) {
    body.append(el('p', 'tiny', `Mesure : ${s.measure}.`));
  }
  if (s.minSizeCm == null && s.status === 'open') {
    body.append(el('p', 'tiny',
      'Aucune taille minimale garantie pour cette espèce dans nos sources. Cela ne veut pas dire qu’il n’y en a pas : vérifier l’arrêté DIRM avant de conserver.'));
  }

  /* ---- Saison ----------------------------------------------------------- */
  body.append(el('div', 'hr'));
  body.append(el('div', 'list-title', '📅 Saison'));
  body.append(seasonBar(s, now));
  body.append(el('div', 'tiny', catalog.seasonLabel(s)));

  /* ---- Reconnaître ------------------------------------------------------ */
  if (s.id_) {
    body.append(el('div', 'hr'));
    body.append(el('div', 'list-title', '👁 Reconnaître'));
    body.append(el('p', 'muted', s.id_));
  }

  /* ---- Pêcher ----------------------------------------------------------- */
  if (s.technique) {
    body.append(el('div', 'list-title', '🎣 Pêcher'));
    body.append(el('p', 'muted', s.technique));
    if (s.habitat.length) {
      const hb = el('div', 'row wrap');
      for (const h of s.habitat) hb.append(chip(h));
      body.append(hb);
    }
  }

  /* ---- Réglementation --------------------------------------------------- */
  if (s.note && s.status === 'open') {
    body.append(el('div', 'hr'));
    body.append(el('div', 'list-title', '⚖️ À savoir'));
    body.append(el('p', 'muted', s.note));
  }
  if (s.scored && SPECIES_RULES[s.id]) {
    const reg = getRegulationStatus(s.id, now);
    if (reg.mode === 'closed') body.append(el('div', 'banner danger', `Fermé aujourd’hui : ${reg.period.note}`));
    else if (reg.mode === 'no-kill') body.append(el('div', 'banner warn', `Capture-relâcher aujourd’hui : ${reg.period.note}`));
  }

  /* ---- Actions ---------------------------------------------------------- */
  if (opts.onPick && s.status !== 'forbidden') {
    const go = button(`🎣 Enregistrer une prise de ${s.name.toLowerCase()}`, 'btn-lime btn-lg', () => {
      closeSheet();
      opts.onPick(s);
    });
    go.style.marginTop = '12px';
    body.append(go);
  }
  if (s.scored) {
    body.append(el('p', 'tiny', 'Cette espèce a un score horaire complet dans le mode PÊCHE.'));
  }
  body.append(el('p', 'tiny',
    `Zone ${catalog.META.zone} · réglementation vérifiée le ${catalog.META.checked}. Ne fait pas autorité : consulter la DIRM Manche Est – Mer du Nord.`));

  openSheet(s.name, body);
}

/**
 * Barre de saison : douze cases, le mois courant encadré. Une saison se lit
 * d'un coup d'œil ou ne se lit pas — une phrase « d'avril à octobre » oblige à
 * situer le mois courant soi-même.
 */
function seasonBar(s, now) {
  const wrap = el('div', 'season-bar');
  const cur = new Date(now).getMonth();
  const LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  for (let i = 0; i < 12; i++) {
    const c = s.season[i];
    const cell = el('div', `season-cell${c === 'X' ? ' peak' : c === 'x' ? ' on' : ''}${i === cur ? ' now' : ''}`, LETTERS[i]);
    wrap.append(cell);
  }
  return wrap;
}

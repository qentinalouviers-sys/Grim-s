/* ==========================================================================
 * ui/wxalertform.js — « préviens-moi quand ça sera bon »
 * --------------------------------------------------------------------------
 * Le formulaire le plus simple possible pour une chose qui ne l'est pas : dire
 * à une machine ce qu'on appelle « du beau temps ».
 *
 * ── PAS DE CHAMPS À REMPLIR ───────────────────────────────────────────────
 * Que des pastilles à toucher. Une case de saisie numérique sur un téléphone,
 * c'est un clavier qui recouvre l'écran, un doigt qui rate, et « 112 nœuds »
 * enregistré sans que personne le voie. Les valeurs proposées couvrent ce
 * qu'un pêcheur côtier utilise réellement, du calme plat au « ça passe encore ».
 *
 * ── L'APERÇU EST LA PIÈCE MAÎTRESSE ───────────────────────────────────────
 * Sous les réglages, l'app dit AUSSITÔT combien de créneaux la règle aurait
 * trouvés dans les sept jours à venir, et quand. Sans ça, on règle à l'aveugle :
 * on met la barre trop haut, on n'est jamais prévenu, et on croit que l'alerte
 * est cassée. Avec, on voit tout de suite qu'à huit nœuds et trente centimètres
 * on n'aura rien de la semaine, et on desserre.
 *
 * ── LE MAIL DEMANDE UN COMPTE, ET C'EST DIT AVANT ─────────────────────────
 * L'app n'a pas d'adresse à elle. Le mail part vers celle du compte, donc il
 * faut un compte — l'écran le montre en haut, avec le bouton pour se
 * connecter, et non après avoir tout rempli.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as fmt from '../core/fmt.js';
import * as wxalert from '../core/wxalert.js';
import * as sync from '../core/sync.js';
import * as places from '../data/places.js';
import { state } from '../core/store.js';
import { sunTimesOfDay } from '../data/astro.js';
import { openAccount } from './account.js';

/* Les valeurs qu'on utilise vraiment. Au-delà de 25 nœuds, la question n'est
 * plus « est-ce que je sors » — c'est déjà répondu. */
const WIND = [5, 8, 10, 12, 15, 18, 22, 25];
const WAVE = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
const HOURS = [2, 3, 4, 6, 8];
const JOURS = [
  { d: 1, l: 'L' }, { d: 2, l: 'M' }, { d: 3, l: 'M' }, { d: 4, l: 'J' },
  { d: 5, l: 'V' }, { d: 6, l: 'S' }, { d: 0, l: 'D' },
];

/* ==========================================================================
 * La liste des alertes
 * ========================================================================== */
export function openAlerts() {
  const body = el('div');
  const list = el('div');

  const paint = () => {
    clear(list);
    const rules = wxalert.all();

    if (!rules.length) {
      list.append(el('p', 'muted',
        'Aucune alerte. Règle tes conditions une fois — vent, mer, durée — et l’app '
        + 'te prévient quand elles se présentent dans les sept jours, au lieu de te '
        + 'faire ouvrir la météo tous les soirs.'));
    }

    for (const r of rules) {
      const card = el('div', `wxa-card${r.enabled ? '' : ' off'}`);
      const head = el('div', 'wxa-head');
      head.append(el('div', 'wxa-name', r.name || 'Alerte bonne météo'));
      const sw = el('button', `wxa-sw${r.enabled ? ' on' : ''}`);
      sw.type = 'button';
      sw.setAttribute('aria-pressed', String(r.enabled));
      sw.setAttribute('aria-label', r.enabled ? 'Désactiver' : 'Activer');
      sw.append(el('span', 'wxa-sw-k'));
      sw.addEventListener('click', async (e) => {
        e.stopPropagation();
        await wxalert.toggle(r.id);
        paint();
      });
      head.append(el('div', 'spacer'), sw);
      card.append(head);
      card.append(el('div', 'wxa-desc', wxalert.describe(r)));

      const où = el('div', 'wxa-where');
      où.append(el('span', null, `📍 ${r.placeName || places.current()?.name || 'port courant'}`));
      const chans = [r.channels?.email ? '✉️ mail' : null, r.channels?.push ? '🔔 notification' : null]
        .filter(Boolean).join(' · ');
      où.append(el('span', 'spacer'), el('span', null, chans || '— aucun canal'));
      card.append(où);

      /* Ce que la règle donnerait MAINTENANT : une alerte qu'on n'a pas encore
       * vue se déclencher n'inspire aucune confiance. */
      const wins = wxalert.windows(r, state.weather?.hourly || [], sunFor);
      const next = wins[0];
      card.append(el('div', `wxa-next${next ? ' hit' : ''}`,
        next ? `→ prochaine fenêtre ${windowLabel(next)}`
          : 'Rien dans les sept jours qui viennent.'));

      const acts = el('div', 'btn-row');
      acts.style.marginTop = '8px';
      acts.append(
        button('Modifier', 'btn-sm', () => openAlertForm(r, paint)),
        button('Supprimer', 'btn-sm', async () => {
          await wxalert.remove(r.id);
          toast('Alerte supprimée');
          paint();
        }),
      );
      card.append(acts);
      list.append(card);
    }
  };

  body.append(accountBanner());
  body.append(list);
  paint();

  const add = button('＋ Nouvelle alerte', 'btn-primary btn-lg', () => openAlertForm(null, paint));
  add.style.marginTop = '10px';
  body.append(add);

  body.append(el('p', 'tiny',
    'L’app vérifie tes alertes à chaque fois qu’elle rafraîchit la météo et te prévient '
    + 'par notification. Le mail, lui, part d’un serveur : il arrive même quand l’app est '
    + 'fermée, dès que l’envoi est en service.'));

  return openSheet('Alertes météo', body);
}

/* ==========================================================================
 * Le formulaire
 * ========================================================================== */
export function openAlertForm(existing, onSaved) {
  const r = { ...wxalert.DEFAULT_RULE, ...(existing || {}) };
  const place = places.current();
  if (!existing) {
    r.placeId = place?.id ?? null;
    r.placeName = place?.name ?? null;
    r.lat = place?.lat ?? null;
    r.lon = place?.lon ?? null;
  }

  const body = el('div');
  body.append(accountBanner());

  /* ---- Vent ---- */
  const preview = el('div', 'wxa-preview');
  const refresh = () => paintPreview(preview, r);

  body.append(section('💨', 'Vent maximum', 'Au-delà, on ne me prévient pas.'));
  body.append(chipRow(WIND, r.windMaxKn, (v) => { r.windMaxKn = v; refresh(); }, (v) => `${v} nd`));

  /* ---- Mer ---- */
  body.append(section('🌊', 'Mer maximum', 'Hauteur significative — houle et clapot ensemble.'));
  body.append(chipRow(WAVE, r.waveMaxM, (v) => { r.waveMaxM = v; refresh(); }, (v) => `${v.toFixed(1)} m`));

  /* ---- Durée ---- */
  body.append(section('⏱', 'Durée minimum', 'Une éclaircie d’une heure n’est pas une sortie.'));
  body.append(chipRow(HOURS, r.minHours, (v) => { r.minHours = v; refresh(); }, (v) => `${v} h`));

  /* ---- Options ---- */
  body.append(section('✨', 'En plus', 'Facultatif — chaque case ajoutée rend l’alerte plus rare.'));
  const opts = el('div', 'wxa-opts');
  const optDefs = [
    { k: 'daylightOnly', ico: '🌅', lbl: 'De jour' },
    { k: 'noRain', ico: '🌧', lbl: 'Sans pluie' },
    { k: 'needSun', ico: '☀️', lbl: 'Grand soleil' },
    { k: 'gust', ico: '💨', lbl: 'Rafales tenues' },
    { k: 'sea', ico: '🌡', lbl: 'Eau ≥ 15°' },
  ];
  for (const o of optDefs) {
    const on = () => (o.k === 'gust' ? r.gustMaxKn != null
      : o.k === 'sea' ? r.seaTempMinC != null : !!r[o.k]);
    const b = el('button', 'wxa-opt');
    b.type = 'button';
    b.append(el('span', 'wxa-opt-i', o.ico), el('span', 'wxa-opt-l', o.lbl));
    const syncCls = () => {
      b.classList.toggle('on', on());
      b.setAttribute('aria-pressed', String(on()));
    };
    b.addEventListener('click', () => {
      if (o.k === 'gust') {
        // « Rafales tenues » veut dire : pas plus de 1,5 fois le vent moyen.
        // C'est l'écart qui rend une journée pénible, pas la pointe seule.
        r.gustMaxKn = r.gustMaxKn == null ? Math.round(r.windMaxKn * 1.5) : null;
      } else if (o.k === 'sea') {
        r.seaTempMinC = r.seaTempMinC == null ? 15 : null;
      } else {
        r[o.k] = !r[o.k];
      }
      syncCls();
      refresh();
    });
    syncCls();
    opts.append(b);
  }
  body.append(opts);

  /* ---- Jours ---- */
  body.append(section('📅', 'Jours qui m’intéressent', 'Tout allumé = tous les jours.'));
  const dayRow = el('div', 'wxa-days');
  for (const j of JOURS) {
    const b = el('button', 'wxa-day');
    b.type = 'button';
    b.textContent = j.l;
    b.title = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][j.d];
    const on = () => !Array.isArray(r.days) || r.days.includes(j.d);
    const syncCls = () => {
      b.classList.toggle('on', on());
      b.setAttribute('aria-pressed', String(on()));
    };
    b.addEventListener('click', () => {
      // Première extinction : on matérialise la liste complète puis on retire.
      if (!Array.isArray(r.days)) r.days = [0, 1, 2, 3, 4, 5, 6];
      r.days = on() ? r.days.filter((d) => d !== j.d) : [...r.days, j.d];
      // Tout rallumé revient à « tous les jours » — un tableau de sept valeurs
      // et `null` doivent se comporter pareil, sinon la phrase de résumé ment.
      if (r.days.length === 7) r.days = null;
      if (r.days && !r.days.length) r.days = null;
      for (const el2 of dayRow.children) el2.dispatchEvent(new Event('resync'));
      refresh();
    });
    b.addEventListener('resync', syncCls);
    syncCls();
    dayRow.append(b);
  }
  body.append(dayRow);

  /* ---- Canaux ---- */
  body.append(section('📨', 'Comment me prévenir', null));
  const chans = el('div', 'wxa-opts');
  const mailBtn = el('button', 'wxa-opt');
  mailBtn.type = 'button';
  mailBtn.append(el('span', 'wxa-opt-i', '✉️'), el('span', 'wxa-opt-l', 'Mail'));
  const pushBtn = el('button', 'wxa-opt');
  pushBtn.type = 'button';
  pushBtn.append(el('span', 'wxa-opt-i', '🔔'), el('span', 'wxa-opt-l', 'Notification'));
  const syncChans = () => {
    mailBtn.classList.toggle('on', !!r.channels?.email);
    pushBtn.classList.toggle('on', !!r.channels?.push);
  };
  mailBtn.addEventListener('click', () => {
    if (!sync.isLoggedIn()) return void toast('Connecte-toi : le mail part vers l’adresse du compte', 'warn', 3200);
    r.channels = { ...r.channels, email: !r.channels?.email };
    syncChans();
  });
  pushBtn.addEventListener('click', () => {
    r.channels = { ...r.channels, push: !r.channels?.push };
    syncChans();
  });
  if (!sync.isLoggedIn()) r.channels = { ...r.channels, email: false };
  syncChans();
  chans.append(mailBtn, pushBtn);
  body.append(chans);

  /* ---- Où ---- */
  body.append(el('div', 'tiny',
    `📍 Conditions relevées pour ${r.placeName || place?.name || 'le port choisi'}. `
    + 'Change de port dans la cabine, puis crée une autre alerte si tu veux les deux.'));

  /* ---- Aperçu ---- */
  body.append(preview);
  refresh();

  /* ---- Enregistrer ---- */
  const save = button('Enregistrer l’alerte', 'btn-primary btn-lg', async () => {
    if (!r.name) r.name = autoName(r);
    await wxalert.save(r);
    closeSheet();
    toast('Alerte enregistrée', 'good');
    onSaved?.();
    // La règle doit monter au serveur : c'est lui qui enverra le mail. Sans
    // compte il n'y a rien à synchroniser, et l'alerte locale suffit.
    if (sync.isLoggedIn()) sync.sync().catch(() => {});
  });
  save.style.marginTop = '12px';
  body.append(save);

  return openSheet(existing ? 'Modifier l’alerte' : 'Nouvelle alerte', body);
}

/* ==========================================================================
 * Morceaux
 * ========================================================================== */

function section(ico, title, hint) {
  const d = el('div', 'wxa-sec');
  d.append(el('span', 'wxa-sec-i', ico), el('span', 'wxa-sec-t', title));
  const wrap = el('div');
  wrap.append(d);
  if (hint) wrap.append(el('div', 'wxa-sec-h', hint));
  return wrap;
}

function chipRow(values, selected, onPick, label) {
  const row = el('div', 'wxa-chips');
  for (const v of values) {
    const b = el('button', `wxa-chip${v === selected ? ' on' : ''}`);
    b.type = 'button';
    b.textContent = label(v);
    b.addEventListener('click', () => {
      for (const c of row.children) c.classList.remove('on');
      b.classList.add('on');
      onPick(v);
    });
    row.append(b);
  }
  return row;
}

/**
 * Le soleil du JOUR qui contient `t`, au port de l'alerte. Sert au filtre
 * « de jour ». Passe par sunTimesOfDay parce que sunTimes découpe ses jours
 * autour de midi : appelé avec une heure du matin, il rend la veille.
 */
function sunFor(t) {
  const p = places.current();
  if (!p) return null;
  return sunTimesOfDay(t, p.lat, p.lon);
}

function windowLabel(w) {
  const j = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][new Date(w.start).getDay()];
  const d = new Date(w.start).getDate();
  return `${j} ${d} de ${fmt.hhmm(w.start)} à ${fmt.hhmm(w.end)} · ${w.hours} h · vent ${Math.round(w.windMaxKn)} nd max`
    + (w.waveMaxM != null ? ` · mer ${w.waveMaxM.toFixed(1)} m` : '');
}

/**
 * L'aperçu. Il répond à la seule question qui compte au moment de régler :
 * « est-ce que ça va sonner un jour ? »
 */
function paintPreview(box, rule) {
  clear(box);
  const hourly = state.weather?.hourly || [];
  if (!hourly.length) {
    box.append(el('div', 'wxa-prev-h', 'Aperçu indisponible'));
    box.append(el('div', 'wxa-prev-s',
      'Pas encore de prévision en mémoire. L’alerte sera quand même enregistrée et testée dès la prochaine connexion.'));
    return;
  }
  const wins = wxalert.windows(rule, hourly, sunFor);
  box.append(el('div', 'wxa-prev-h',
    wins.length === 0 ? 'Aucun créneau dans les 7 jours'
      : wins.length === 1 ? '1 créneau dans les 7 jours'
        : `${wins.length} créneaux dans les 7 jours`));

  if (!wins.length) {
    /* On ne se contente pas de dire non : on dit CE QUI COINCE. Sans ça,
     * l'utilisateur desserre au hasard, essaie trois fois, et abandonne. */
    box.append(el('div', 'wxa-prev-s', blocker(rule, hourly)));
    return;
  }
  for (const w of wins.slice(0, 4)) box.append(el('div', 'wxa-prev-w', windowLabel(w)));
  if (wins.length > 4) box.append(el('div', 'wxa-prev-s', `…et ${wins.length - 4} autres.`));
}

/** Quel critère élimine le plus d'heures ? Celui-là est le vrai verrou. */
function blocker(rule, hourly) {
  const now = Date.now();
  const soon = hourly.filter((h) => h.t >= now && h.t < now + 7 * 86400000);
  if (!soon.length) return 'Prévision trop courte pour le dire.';

  const tests = [
    ['le vent', (h) => (h.windSpeedKn ?? 0) <= rule.windMaxKn],
    ['la mer', (h) => rule.waveMaxM == null || (h.waveHeightM != null && h.waveHeightM <= rule.waveMaxM)],
    ['les rafales', (h) => rule.gustMaxKn == null || (h.windGustKn ?? 0) <= rule.gustMaxKn],
    ['la pluie', (h) => !rule.noRain || (h.precipMm ?? 0) <= 0.2],
    ['le soleil demandé', (h) => !rule.needSun || (h.cloudPct ?? 100) <= 40],
    ['la température de l’eau', (h) => rule.seaTempMinC == null || (h.seaTempC ?? -99) >= rule.seaTempMinC],
  ];
  let worst = null;
  for (const [nom, ok] of tests) {
    const pass = soon.filter(ok).length;
    if (worst == null || pass < worst.pass) worst = { nom, pass };
  }
  if (worst && worst.pass === 0) return `Sur les sept jours, aucune heure ne tient ${worst.nom}. Desserre ce seuil.`;
  const total = soon.filter((h) => wxalert.hourPasses(rule, h, sunFor(h.t))).length;
  if (total > 0) {
    return `${total} h conviennent, mais jamais ${rule.minHours} h d’affilée. Baisse la durée minimum.`;
  }
  return `Le critère le plus dur est ${worst.nom} : seules ${worst.pass} h sur ${soon.length} le tiennent.`;
}

function autoName(r) {
  return `Sortie ≤ ${Math.round(r.windMaxKn)} nd${r.waveMaxM != null ? ` / ${r.waveMaxM.toFixed(1)} m` : ''}`;
}

/**
 * Le bandeau de compte. En HAUT, pas en bas : découvrir qu'il faut un compte
 * après avoir réglé six critères, c'est tout perdre.
 */
function accountBanner() {
  if (sync.isLoggedIn()) {
    const d = el('div', 'banner info');
    d.append(el('span', null, `Le mail partira sur ${sync.authEmail()}.`));
    return d;
  }
  const d = el('div', 'banner warn');
  d.append(el('span', null,
    'Sans compte, pas d’adresse où t’écrire : le mail demande une connexion. '
    + 'La notification sur ce téléphone, elle, marche déjà.'));
  d.append(button('Se connecter', 'btn-sm', () => openAccount()));
  return d;
}

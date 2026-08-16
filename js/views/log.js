/* ==========================================================================
 * views/log.js — JOURNAL, réglages et calibration
 * --------------------------------------------------------------------------
 * L'écran où l'app rend des comptes : ce qu'elle a appris, sur quelles
 * données, et avec quelle marge d'erreur. Un modèle qui s'ajuste sans dire
 * de combien fabrique de la fausse confiance — le pire défaut possible pour
 * un outil qu'on emmène en mer.
 * ========================================================================== */

import { state, set, on, emit } from '../core/store.js';
import { el, clear, button, chip, collapsible, toast, openSheet, closeSheet } from '../ui/dom.js';
import * as profile from '../core/profile.js';
import { openBoatForm } from '../ui/boat.js';
import { openShare, renderQR, appUrl } from '../ui/share.js';
import * as install from '../ui/install.js';
import * as fmt from '../core/fmt.js';
import * as learning from '../fishing/learning.js';
import * as spots from '../fishing/spots.js';
import * as stream from '../data/stream.js';
import * as tide from '../data/tide.js';
import * as idb from '../core/idb.js';
import * as record from '../fishing/record.js';
import * as account from '../ui/account.js';
import * as sync from '../core/sync.js';
import * as rescue from '../ui/rescue.js';
import * as wxalert from '../core/wxalert.js';
import * as soundings from '../fishing/soundings.js';
import { openAlerts } from '../ui/wxalertform.js';

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
on('profile:changed', () => refs.body && render());
on('account:changed', () => refs.body && render());
on('sync:done', () => refs.body && render());

/** Libellé lisible d'un identifiant de liste (coque, motorisation, pêche). */
const profileLabel = (list, id) => list.find((x) => x.id === id)?.name || null;

async function render() {
  const box = clear(refs.body);

  /* ══ Le bateau ═══════════════════════════════════════════════════════
     En tête du journal, parce que c'est l'identité de tout le reste : le nom
     qui part à la VHF, la coque et la taille qui décident de ce qui est
     raisonnable comme mer, et demain le compte de la communauté. */
  const p = state.profile || {};
  const boatCard = el('div', 'card');
  const bh = el('div', 'card-head');
  bh.append(el('h3', null, 'MON BATEAU'), el('div', 'spacer'));
  bh.append(button(p.boatName ? 'Modifier' : 'Renseigner', 'btn-sm', () => openBoatForm({ onSaved: render })));
  boatCard.append(bh);
  if (p.boatName) {
    boatCard.append(el('div', 'list-title', p.boatName));
    const bits = [
      profileLabel(profile.HULL_TYPES, p.hull),
      p.lengthM ? `${String(p.lengthM).replace('.', ',')} m` : null,
      profileLabel(profile.PROPULSIONS, p.propulsion),
      p.powerHp ? `${p.powerHp} ch` : null,
      p.pob ? `${p.pob} à bord` : null,
    ].filter(Boolean);
    boatCard.append(el('div', 'list-sub', bits.join(' · ') || 'Fiche incomplète'));
    if (p.fishing?.length) {
      const fr = el('div', 'row wrap');
      fr.style.marginTop = '6px';
      for (const f of p.fishing) fr.append(chip(profileLabel(profile.FISHING_TYPES, f) || f));
      boatCard.append(fr);
    }
    if (p.lengthM && p.hull) {
      const c = profile.comfort(p);
      boatCard.append(el('div', 'tiny', `Seuils de confort déduits : mer ≤ ${String(c.seaLimitM).replace('.', ',')} m, vent ≤ ${c.windLimitKn} nd. Le guide prévient au-delà.`));
    }
  } else {
    boatCard.append(el('p', 'muted', 'Nom, coque, taille, motorisation, types de pêche. Le nom part dans le message de détresse ; la coque et la taille adaptent les avertissements à ton bateau plutôt qu’à un bateau moyen.'));
  }
  box.append(boatCard);

  /* ══ Compte & synchro ═════════════════════════════════════════════════
     Le compte est optionnel : l'app reste pleinement utilisable sans. La
     carte affiche l'état réel — connecté ou non, dernière synchro — sans
     jamais promettre de serveur quand il n'y a pas de réseau. */
  const acctCard = el('div', 'card');
  const acctHead = el('div', 'card-head');
  acctHead.append(el('h3', null, 'COMPTE & SYNCHRO'), el('div', 'spacer'));
  if (sync.isLoggedIn()) {
    acctHead.append(button('Gérer', 'btn-sm', () => account.openAccount()));
    acctCard.append(acctHead);
    acctCard.append(el('div', 'list-title', sync.authEmail() || 'Connecté'));
    acctCard.append(el('div', 'list-sub',
      state.syncing
        ? 'Synchronisation en cours…'
        : state.lastSyncAt
          ? `Dernière synchro il y a ${fmt.age(state.lastSyncAt)}.`
          : 'Connecté — en attente de la première synchro.'));
  } else {
    acctHead.append(button('Se connecter', 'btn-sm', () => account.openAccount()));
    acctCard.append(acctHead);
    acctCard.append(el('p', 'muted',
      'Retrouve ton journal et tes marques sur un autre téléphone, et sauvegarde-les. Sans compte, tout reste sur cet appareil.'));
  }
  /* Les alertes météo tiennent au compte — c'est son adresse qui reçoit le
   * mail — donc leur place est ici autant que sur la carte météo. Deux portes
   * pour une même pièce, et c'est voulu : on cherche « mes alertes » du côté
   * des réglages aussi souvent que du côté de la météo. */
  const alertRow = el('button', 'list-item');
  alertRow.type = 'button';
  const alertMain = el('div', 'list-main');
  alertMain.append(el('div', 'list-title', '🔔 Alertes bonne météo'));
  const n = wxalert.enabledCount();
  alertMain.append(el('div', 'list-sub', n
    ? `${n} alerte${n > 1 ? 's' : ''} en veille — tu seras prévenu dès que tes conditions se présentent.`
    : 'Se faire prévenir quand le vent et la mer passent sous tes seuils.'));
  alertRow.append(alertMain, el('span', 'chev', '›'));
  alertRow.addEventListener('click', () => openAlerts());
  acctCard.append(alertRow);

  box.append(acctCard);

  /* ══ Carnet de sondes ═════════════════════════════════════════════════
     La donnée la plus chère à obtenir de toute l'app : elle ne se télécharge
     pas, elle se relève, sortie après sortie, en passant sur le poste. Elle
     mérite donc d'être visible, chiffrée, et exportable — un carnet qu'on ne
     peut pas sortir de l'app est un carnet qu'on finit par perdre. */
  const st = soundings.stats();
  const sndCard = el('div', 'card');
  const sndHead = el('div', 'card-head');
  sndHead.append(el('h3', null, 'CARNET DE SONDES'), el('div', 'spacer'));
  sndHead.append(el('span', `chip ${st.n ? 'good' : ''}`, `${st.n} relevé${st.n > 1 ? 's' : ''}`));
  sndCard.append(sndHead);

  if (!st.n) {
    sndCard.append(el('p', 'muted',
      'Aucune sonde. Le modèle public fait cent mètres de maille : il montre le plateau et '
      + 'les fosses, pas le ridin. Tes propres relevés, eux, sont au mètre — et ils priment '
      + 'sur le modèle partout où tu es passé. Bouton « 📏 SONDE » dans le mode pêche.'));
  } else {
    sndCard.append(el('div', 'list-title',
      `${st.minM} à ${st.maxM} m au zéro des cartes`));
    sndCard.append(el('div', 'list-sub',
      `${st.corrigées} sonde${st.corrigées > 1 ? 's' : ''} corrigée${st.corrigées > 1 ? 's' : ''} de la marée`
      + ` · depuis le ${new Date(st.depuis).toLocaleDateString('fr-FR')}`
      + ` · dernière ${fmt.age(st.derniere)}`));
    if (st.corrigées < st.n) {
      sndCard.append(el('div', 'tiny',
        `${st.n - st.corrigées} relevé(s) hors de la zone du modèle de marée : gardés bruts, non corrigés.`));
    }

    const sndRow = el('div', 'btn-row');
    sndRow.style.marginTop = '10px';
    sndRow.append(
      button('📤 GPX', 'btn-sm', () => saveFile(soundings.toGPX(),
        `grims-sondes-${new Date().toISOString().slice(0, 10)}.gpx`, 'application/gpx+xml')),
      button('📄 CSV', 'btn-sm', () => saveFile(soundings.toCSV(),
        `grims-sondes-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv')),
    );
    sndCard.append(sndRow);

    /* L'effacement demande confirmation, contrairement aux traces de dérive :
       celles-ci valent pour la sortie du jour, les sondes valent des années. */
    const wipe = button('Effacer le carnet', 'btn-sm', () => {
      const c = el('div');
      c.append(el('p', null,
        `${st.n} sondes relevées depuis le ${new Date(st.depuis).toLocaleDateString('fr-FR')} vont être effacées. `
        + 'Elles ne se retéléchargent pas : elles ont été mesurées à bord. Exporte-les d’abord si tu hésites.'));
      c.append(button('Effacer définitivement', 'btn-danger btn-lg', async () => {
        await soundings.clear();
        closeSheet();
        toast('Carnet de sondes effacé');
        render();
      }));
      openSheet('Effacer le carnet de sondes', c);
    });
    wipe.style.marginTop = '8px';
    sndCard.append(wipe);
  }
  box.append(sndCard);

  /* ══ Sauvegarde ══════════════════════════════════════════════════════
     Placée haut, et pas dans les réglages : une sauvegarde qu'on ne voit
     pas est une sauvegarde qu'on ne fait pas. La carte ne parle que s'il y
     a quelque chose à perdre. */
  const bk = await rescue.backupCard();
  if (bk) box.append(bk);

  /* ══ Passer l'app au bateau d'à côté ═════════════════════════════════
     Une vignette, pas un bouton : le code se voit, donc le geste s'invente
     tout seul. Un lien caché derrière un menu « Partager » ne se tend pas
     par-dessus un pare-battage. */
  const shareCard = el('div', 'card');
  const shh = el('div', 'card-head');
  shh.append(el('h3', null, 'PARTAGER L’APP'));
  shareCard.append(shh);
  const shRow = el('div', 'row');
  const thumb = el('div', 'qr-thumb');
  try {
    thumb.append(renderQR(appUrl(), 88));
  } catch { /* rendu impossible : le bouton reste */ }
  const shMain = el('div', 'list-main');
  shMain.append(el('div', 'list-title', 'Un code à faire viser'));
  shMain.append(el('div', 'list-sub', 'Bord à bord, sans réseau et sans épeler d’adresse dans le vent. Le code est calculé à bord.'));
  shRow.append(thumb, shMain);
  shareCard.append(shRow);
  const shBtn = button('Afficher en grand', 'btn-sm', () => openShare());
  shBtn.style.marginTop = '10px';
  shareCard.append(shBtn);
  const appBox = el('div');
  appBox.append(shareCard, install.card());
  for (const c of appBox.querySelectorAll('.card')) c.style.marginBottom = '8px';
  /* Titre explicite : « APPLICATION » ne dit pas ce qu'on y trouve, et le
   * partage bord à bord est justement ce qu'on cherche quand un voisin de
   * ponton demande « c'est quoi, ton appli ? ». */
  box.append(collapsible('PARTAGER & INSTALLER', appBox, { hint: 'QR code bord à bord' }));

  /* ══ Ce que le modèle a appris ═══════════════════════════════════════ */
  const learnCard = el('div');
  for (const item of learning.explain()) {
    const r = el('div');
    r.style.padding = '5px 0';
    r.append(el('div', 'list-title', item.title));
    r.append(el('div', 'list-sub', item.text));
    learnCard.append(r);
  }
  box.append(collapsible('CE QUE LE MODÈLE A APPRIS', learnCard,
    { hint: `${learning.model().totalCatches || 0} prises` }));

  /* ══ Journal de captures ═════════════════════════════════════════════ */
  const list = (await learning.catches()).sort((a, b) => b.t - a.t);
  const catchCard = el('div', 'card flush');
  const ch = el('div', 'card-head');
  ch.style.padding = '12px 12px 0';
  ch.append(el('h3', null, `PRISES (${list.length})`), el('div', 'spacer'));
  const add = button('🎣 Prise', 'btn-sm', () => record.openQuickRecord());
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
      const info = record.speciesInfo(c.speciesId, c.speciesName);
      const title = el('div', 'list-title',
        `${info.emoji} ${info.name}${c.lengthCm ? ` · ${c.lengthCm} cm` : ''}${c.count > 1 ? ` ×${c.count}` : ''}`);
      title.style.borderLeft = `3px solid ${info.color}`;
      title.style.paddingLeft = '7px';
      main.append(title);
      main.append(el('div', 'list-sub', [
        new Date(c.t).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
        c.released ? 'relâché' : null,
        c.snapshot?.coefficient != null ? `coef ${c.snapshot.coefficient}` : null,
        c.snapshot?.nearestSpot ? c.snapshot.nearestSpot.name : null,
        Number.isFinite(c.lat) ? '📍' : 'sans point',
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
  spotCard.style.marginBottom = '0';
  const sh = el('div', 'card-head');
  sh.style.padding = '0 0 8px';
  sh.append(el('div', 'spacer'));
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
  box.append(collapsible(`MES MARQUES`, spotCard, { hint: `${personal.length}`, open: false }));

  /* ══ Repliés : on les ouvre quand on en a besoin, pas à chaque fois ══ */
  box.append(collapsible('CALIBRATION DU COURANT', calibrationCard(),
    { hint: stream.config().calibrated ? 'calibré' : 'non calibré' }));
  box.append(collapsible('RÉGLAGES & DONNÉES', await settingsCard()));
  box.append(collapsible('SOURCES & MENTIONS', aboutCard()));
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
  const info = record.speciesInfo(c.speciesId, c.speciesName);
  const body = el('div');

  const head = el('div', 'row');
  const badge = el('div', 'score-badge');
  badge.style.background = info.color;
  badge.style.color = '#050b14';
  badge.textContent = info.emoji;
  const main = el('div', 'list-main');
  main.append(el('div', 'list-title',
    `${info.name}${c.lengthCm ? ` · ${c.lengthCm} cm` : ''}${(c.count || 1) > 1 ? ` ×${c.count}` : ''}`));
  main.append(el('div', 'list-sub',
    `${new Date(c.t).toLocaleString('fr-FR')}${c.released ? ' · relâché' : ' · gardé'}`));
  head.append(badge, main);
  body.append(head);

  if (c.note) body.append(el('p', 'muted', c.note));
  body.append(el('div', 'hr'));

  if (!c.snapshot) {
    body.append(el('p', 'tiny', 'Prise enregistrée sans contexte (version antérieure de l’app).'));
  } else {
    body.append(record.renderSnapshot(c.snapshot));
  }

  const acts = el('div', 'btn-row');
  if (Number.isFinite(c.lat)) {
    acts.append(button('🗺️ Voir sur la carte', 'btn-primary', () => {
      set({ waypoint: { lat: c.lat, lon: c.lon, name: info.name } });
      closeSheet();
      emit('goto', 'map');
    }));
  }
  acts.append(button('Supprimer', 'btn-ghost', async () => {
    await learning.removeCatch(c.id);
    closeSheet();
    emit('catches:changed');
    render();
    toast('Prise supprimée');
  }));
  body.append(acts);

  openSheet(info.name, body);
}

/* ==========================================================================
 * À propos
 * ========================================================================== */
function aboutCard() {
  const c = el('div', 'card');

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

/* --------------------------------------------------------------------------
 * Enregistrer un fichier
 * --------------------------------------------------------------------------
 * L'URL d'objet est révoquée après le clic : sans ça, chaque export garde son
 * contenu en mémoire jusqu'au rechargement de la page, et un carnet de trois
 * mille sondes exporté cinq fois pèse lourd sur un téléphone.
 * ------------------------------------------------------------------------ */
function saveFile(text, filename, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`${filename} exporté`, 'good');
  } catch {
    toast('Export impossible sur ce navigateur', 'danger');
  }
}

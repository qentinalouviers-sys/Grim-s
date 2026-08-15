/* ==========================================================================
 * ui/rescue.js — retrouver ses données, et ne plus les reperdre
 * --------------------------------------------------------------------------
 * Un carnet de marques perdu, c'est plusieurs saisons de sondeur. Cet écran
 * existe parce que c'est arrivé, et il fait trois choses dans cet ordre :
 *
 *   1. IL CHERCHE. Il ouvre TOUTES les bases IndexedDB de l'origine, pas
 *      seulement celle de l'app, compte ce qu'il y a dedans, et regarde aussi
 *      localStorage. Une base orpheline laissée par une version antérieure ou
 *      par une autre adresse est récupérable — encore faut-il la voir.
 *
 *   2. IL DIT LA VÉRITÉ. Si le navigateur a purgé, il n'y a rien à récupérer
 *      et il vaut mieux l'entendre tout de suite que d'espérer.
 *
 *   3. IL EMPÊCHE LA PROCHAINE FOIS.
 *
 * ── POURQUOI ÇA ARRIVE, ET CE QUI PROTÈGE VRAIMENT ────────────────────────
 * iOS efface le stockage d'un SITE SIMPLEMENT VISITÉ au bout de sept jours
 * sans ouverture. C'est une règle de la plateforme, pas un réglage : Safari
 * n'expose même pas navigator.storage.persist(), donc l'app ne peut pas
 * demander à être épargnée. Le seul contournement est l'INSTALLATION sur
 * l'écran d'accueil : une app installée n'est pas soumise à cette purge.
 *
 * D'où la hiérarchie affichée ici, dans l'ordre d'efficacité réelle :
 *   installer  > sauvegarder régulièrement > compte de synchronisation.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as idb from '../core/idb.js';
import * as learning from '../fishing/learning.js';
import * as spots from '../fishing/spots.js';
import * as install from './install.js';
import { emit } from '../core/store.js';

/* --------------------------------------------------------------------------
 * 1. L'inventaire
 * ------------------------------------------------------------------------ */

/** Ce que contient une base IndexedDB, sans rien y écrire. */
function inspectDb(name) {
  return new Promise((resolve) => {
    let req;
    try {
      // Sans numéro de version : on ouvre l'existante telle quelle. Passer une
      // version supérieure déclencherait une migration — sur une base qu'on
      // vient précisément récupérer, ce serait le comble.
      req = indexedDB.open(name);
    } catch {
      return resolve({ name, error: 'ouverture refusée' });
    }
    req.onerror = () => resolve({ name, error: 'illisible' });
    req.onsuccess = async () => {
      const db = req.result;
      const stores = [...db.objectStoreNames];
      const counts = {};
      for (const s of stores) {
        counts[s] = await new Promise((res) => {
          try {
            const r = db.transaction(s, 'readonly').objectStore(s).count();
            r.onsuccess = () => res(r.result);
            r.onerror = () => res(-1);
          } catch {
            res(-1);
          }
        });
      }
      // kv est un fourre-tout : le compte brut ne dit pas si les marques y
      // sont. On va chercher la clé qui compte.
      let spotsInKv = null;
      if (stores.includes('kv')) {
        spotsInKv = await new Promise((res) => {
          try {
            const r = db.transaction('kv', 'readonly').objectStore('kv').get('spots');
            r.onsuccess = () => res(Array.isArray(r.result) ? r.result.length : null);
            r.onerror = () => res(null);
          } catch {
            res(null);
          }
        });
      }
      db.close();
      resolve({ name, version: db.version, stores, counts, spotsInKv });
    };
  });
}

/** Tout ce qui est encore sur cet appareil pour cette adresse. */
export async function scan() {
  const out = {
    origin: location.origin,
    path: location.pathname,
    standalone: install.isStandalone(),
    dbs: [],
    localStorage: [],
    estimate: null,
    persisted: null,
    caches: [],
  };

  try {
    if (navigator.storage?.estimate) out.estimate = await navigator.storage.estimate();
  } catch { /* rien */ }
  try {
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
  } catch { /* Safari n'expose pas l'API */ }

  let names = [];
  try {
    // indexedDB.databases() n'existe pas sur Safari : on retombe sur les noms
    // que l'app a pu utiliser au fil des versions.
    names = navigator.userAgent && indexedDB.databases
      ? (await indexedDB.databases()).map((d) => d.name).filter(Boolean)
      : [];
  } catch { /* rien */ }
  const KNOWN = ['grims-compagnon', 'grims', 'grims-compagnon-v1', 'compagnon'];
  for (const k of KNOWN) if (!names.includes(k)) names.push(k);

  for (const n of names) {
    const info = await inspectDb(n);
    // Une base ouverte par nous à l'instant et vide de tout magasin n'a jamais
    // existé : ne pas la présenter comme une piste.
    if (!info.error && (!info.stores || info.stores.length === 0)) continue;
    out.dbs.push(info);
  }

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.localStorage.push({ key: k, size: (localStorage.getItem(k) || '').length });
    }
  } catch { /* mode privé */ }

  try {
    if (window.caches) out.caches = await caches.keys();
  } catch { /* rien */ }

  return out;
}

/** Y a-t-il quelque chose à récupérer ailleurs que dans la base courante ? */
function salvageable(report) {
  return report.dbs.filter((d) => {
    if (d.error || d.name === 'grims-compagnon') return false;
    const c = d.counts || {};
    return (c.catches > 0) || (c.tracks > 0) || (d.spotsInKv > 0);
  });
}

/* --------------------------------------------------------------------------
 * 2. L'écran
 * ------------------------------------------------------------------------ */
export async function openRescue() {
  const body = el('div');
  body.append(el('div', 'muted', 'Inspection du stockage de cet appareil…'));
  openSheet('Récupérer mes données', body);

  const report = await scan();
  const cur = report.dbs.find((d) => d.name === 'grims-compagnon');
  const nCatches = cur?.counts?.catches ?? 0;
  const nSpots = cur?.spotsInKv ?? 0;
  const nTracks = cur?.counts?.tracks ?? 0;
  const nTiles = cur?.counts?.tiles ?? 0;
  const found = salvageable(report);

  clear(body);

  /* ── Verdict, en premier et en clair ─────────────────────────────────── */
  const verdict = el('div', 'card');
  const vh = el('div', 'card-head');
  vh.append(el('h3', null, 'CE QUI EST ENCORE LÀ'));
  verdict.append(vh);

  const strip = el('div', 'strip');
  strip.append(countPill(nCatches, 'PRISES'), countPill(nSpots, 'MARQUES'),
    countPill(nTracks, 'TRACES'), countPill(nTiles, 'TUILES'));
  verdict.append(strip);

  const empty = nCatches === 0 && nSpots === 0 && nTracks === 0;
  if (empty && !found.length) {
    verdict.append(el('p', 'muted',
      'Rien dans le stockage de cet appareil pour cette adresse. Si tu avais des marques, elles ont été effacées par le navigateur — l’app n’a aucun moyen de les recréer. La suite de cet écran explique pourquoi et comment l’empêcher.'));
  } else if (empty) {
    verdict.append(el('p', 'muted',
      'La base courante est vide, mais une autre base porte des données. Elle vient d’une version antérieure ou d’une autre adresse — on peut la récupérer.'));
  } else {
    verdict.append(el('p', 'muted', 'Tes données sont là. Sauvegarde-les maintenant, avant toute autre manipulation.'));
  }
  body.append(verdict);

  /* ── Sauvegarde, avant tout le reste ─────────────────────────────────── */
  if (!empty) {
    const save = button('💾 Sauvegarder tout dans un fichier', 'btn-primary btn-lg', backupNow);
    save.style.marginBottom = '10px';
    body.append(save);
  }

  /* ── Récupération depuis une base orpheline ──────────────────────────── */
  if (found.length) {
    const rec = el('div', 'card');
    const rh = el('div', 'card-head');
    rh.append(el('h3', null, 'DONNÉES RÉCUPÉRABLES'));
    rec.append(rh);
    for (const d of found) {
      const row = el('div');
      row.style.padding = '6px 0';
      row.append(el('div', 'list-title', d.name));
      row.append(el('div', 'list-sub',
        `${d.counts.catches || 0} prises · ${d.spotsInKv || 0} marques · ${d.counts.tracks || 0} traces`));
      row.append(button('Récupérer dans l’app', 'btn-sm btn-lime', () => recoverFrom(d.name)));
      rec.append(row);
    }
    body.append(rec);
  }

  /* ── Importer une sauvegarde ─────────────────────────────────────────── */
  const imp = el('div', 'card');
  const ih = el('div', 'card-head');
  ih.append(el('h3', null, 'J’AI UNE SAUVEGARDE'));
  imp.append(ih);
  imp.append(el('p', 'muted',
    'Un fichier .json exporté par l’app, ou un .gpx venant d’un traceur ou d’une autre app de navigation.'));
  const row = el('div', 'row');
  row.append(
    button('Importer .json', 'btn-sm', () => pickFile('application/json,.json', async (text) => {
      await learning.importAll(JSON.parse(text));
      toast('Sauvegarde restaurée', 'good');
      emit('spots:changed');
      emit('catches:changed');
      closeSheet();
    })),
    button('Importer .gpx', 'btn-sm', () => pickFile('.gpx,application/gpx+xml,application/xml,text/xml', async (text) => {
      const n = await spots.importGPX(text);
      toast(`${n} marque${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}`, 'good');
      emit('spots:changed');
      closeSheet();
    })),
  );
  imp.append(row);
  body.append(imp);

  /* ── Pourquoi, et comment l'éviter ───────────────────────────────────── */
  const why = el('div', 'card');
  const wh = el('div', 'card-head');
  wh.append(el('h3', null, 'POURQUOI ÇA ARRIVE'));
  why.append(wh);
  why.append(el('p', 'muted',
    'iOS efface le stockage d’un site simplement VISITÉ au bout de sept jours sans ouverture. C’est une règle du système, pas un réglage : Safari ne permet même pas à une page de demander à être épargnée. Android est plus clément mais peut faire le ménage sous pression de stockage.'));

  const steps = [
    [install.isStandalone() ? '✅' : '1️⃣',
      'Installer sur l’écran d’accueil',
      install.isStandalone()
        ? 'C’est fait. Une app installée échappe à la purge des sept jours.'
        : 'C’est LA protection qui marche. Une app installée n’est pas soumise à la purge.'],
    ['2️⃣', 'Sauvegarder après chaque sortie',
      'Un fichier .json dans tes fichiers ou ton nuage. Trente secondes, et c’est la seule copie qui ne dépend pas de ce téléphone.'],
    ['3️⃣', 'Créer un compte',
      'La synchronisation remet tes marques sur n’importe quel appareil. C’est la ceinture ; le fichier reste les bretelles.'],
  ];
  for (const [n, title, txt] of steps) {
    const r = el('div', 'row');
    r.style.alignItems = 'flex-start';
    r.style.padding = '7px 0';
    const badge = el('div', 'score-badge', n);
    badge.style.background = 'var(--bg-2)';
    badge.style.minWidth = '38px';
    const main = el('div', 'list-main');
    main.append(el('div', 'list-title', title), el('div', 'list-sub', txt));
    r.append(badge, main);
    why.append(r);
  }
  if (!install.isStandalone()) {
    const b = button('📲 Installer maintenant', 'btn-primary btn-lg', () => install.prompt());
    b.style.marginTop = '8px';
    why.append(b);
  }
  body.append(why);

  /* ── L'état brut, pour qui veut vérifier ─────────────────────────────── */
  const tech = el('details', 'card fold');
  const sum = document.createElement('summary');
  sum.className = 'fold-head';
  sum.append(el('h3', null, 'ÉTAT DU STOCKAGE'), el('span', 'fold-chevron', '⌄'));
  tech.append(sum);
  const tb = el('div', 'fold-body tiny');
  tb.append(el('div', null, `Adresse : ${report.origin}${report.path}`));
  tb.append(el('div', null, `Mode : ${report.standalone ? 'application installée' : 'onglet de navigateur'}`));
  tb.append(el('div', null, `Stockage durable : ${report.persisted === null ? 'non exposé par ce navigateur (Safari)' : report.persisted ? 'accordé' : 'refusé'}`));
  if (report.estimate?.usage != null) {
    tb.append(el('div', null,
      `Occupé : ${(report.estimate.usage / 1048576).toFixed(1)} Mo sur ${(report.estimate.quota / 1048576).toFixed(0)} Mo`));
  }
  for (const d of report.dbs) {
    tb.append(el('div', null, d.error
      ? `base ${d.name} : ${d.error}`
      : `base ${d.name} v${d.version} — ${Object.entries(d.counts).map(([k, v]) => `${k}:${v}`).join(' · ')}${d.spotsInKv != null ? ` · marques:${d.spotsInKv}` : ''}`));
  }
  tb.append(el('div', null, `localStorage : ${report.localStorage.length} clé(s)`));
  tb.append(el('div', null, `caches : ${report.caches.join(', ') || 'aucun'}`));
  tech.append(tb);
  body.append(tech);
}

function countPill(n, label) {
  const p = el('div', 'pill');
  p.style.minWidth = '78px';
  const v = el('div', 'pill-val', String(n));
  if (!n) v.style.color = 'var(--txt-3)';
  p.append(v, el('div', 'pill-lbl', label));
  return p;
}

function pickFile(accept, onText) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      await onText(await f.text());
    } catch (e) {
      toast(`Fichier illisible : ${e.message}`, 'danger');
    }
  });
  input.click();
}

/* --------------------------------------------------------------------------
 * 3. Les actions
 * ------------------------------------------------------------------------ */

/** Export complet, y compris ce que exportAll() ne couvre pas. */
export async function backupNow() {
  const data = await learning.exportAll();
  const full = {
    ...data,
    profile: await idb.get('kv', 'profile'),
    settings: await idb.get('kv', 'settings'),
    customSpecies: await idb.get('kv', 'customSpecies'),
    tracks: await idb.all('tracks'),
  };
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `grims-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  await idb.put('kv', 'lastBackupAt', Date.now());
  toast('Sauvegarde enregistrée dans tes fichiers', 'good', 4500);
  emit('backup:done');
}

/** Recopie une base orpheline dans la base courante, sans rien écraser. */
async function recoverFrom(name) {
  const info = await inspectDb(name);
  if (info.error) return void toast('Base illisible', 'danger');

  const readAll = (store) => new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        return resolve([]);
      }
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => { db.close(); resolve(r.result || []); };
      r.onerror = () => { db.close(); resolve([]); };
    };
  });
  const readKv = (key) => new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) { db.close(); return resolve(null); }
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => { db.close(); resolve(r.result ?? null); };
      r.onerror = () => { db.close(); resolve(null); };
    };
  });

  const oldCatches = await readAll('catches');
  const oldTracks = await readAll('tracks');
  const oldSpots = (await readKv('spots')) || [];

  // FUSION, jamais remplacement : si l'utilisateur a déjà repêché trois
  // marques depuis la perte, elles ne doivent pas disparaître au moment où il
  // récupère les anciennes.
  let nC = 0;
  for (const c of oldCatches) {
    if (!c?.id) continue;
    if (await idb.get('catches', c.id)) continue;
    await idb.put('catches', null, c);
    nC++;
  }
  let nT = 0;
  for (const t of oldTracks) {
    if (!t?.id) continue;
    if (await idb.get('tracks', t.id)) continue;
    await idb.put('tracks', null, t);
    nT++;
  }
  const curSpots = (await idb.get('kv', 'spots')) || [];
  const seen = new Set(curSpots.map((s) => s.id));
  const merged = [...curSpots];
  let nS = 0;
  for (const s of oldSpots) {
    if (!s?.id || seen.has(s.id)) continue;
    merged.push(s);
    seen.add(s.id);
    nS++;
  }
  if (nS) await idb.put('kv', 'spots', merged);

  await spots.init();
  emit('spots:changed');
  emit('catches:changed');
  toast(`Récupéré : ${nC} prises, ${nS} marques, ${nT} traces`, 'good', 6000);
  closeSheet();
}

/* --------------------------------------------------------------------------
 * 4. Le rappel
 * --------------------------------------------------------------------------
 * Pas un bandeau à chaque ouverture — on l'ignorerait au bout de trois fois.
 * Une carte dans le JOURNAL, qui ne parle que quand il y a quelque chose à
 * perdre et que la dernière sauvegarde date.
 * ------------------------------------------------------------------------ */
export async function backupCard() {
  const last = await idb.get('kv', 'lastBackupAt');
  const nCatches = (await learning.catches()).length;
  const nSpots = spots.personalSpots().length;
  if (!nCatches && !nSpots) return null;

  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  const stale = days === null || days > 21;
  const risky = !install.isStandalone();

  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.append(el('h3', null, 'SAUVEGARDE'), el('div', 'spacer'));
  h.append(el('span', 'tiny', last ? `il y a ${days} j` : 'jamais'));
  c.append(h);
  c.append(el('div', 'list-title', `${nCatches} prises et ${nSpots} marques sur cet appareil`));
  c.append(el('div', 'list-sub', stale
    ? (risky
      ? 'Rien n’est sauvegardé ailleurs, et l’app tourne dans un onglet : iOS efface le stockage d’un site non installé au bout de sept jours sans ouverture.'
      : 'Rien n’est sauvegardé ailleurs. Un fichier met trente secondes et ne dépend pas de ce téléphone.')
    : 'À jour. Refais-en une après chaque bonne sortie.'));

  const row = el('div', 'btn-row');
  row.style.marginTop = '8px';
  row.append(
    button('💾 Sauvegarder', stale ? 'btn-primary' : '', backupNow),
    button('🔎 Récupérer', '', () => openRescue()),
  );
  c.append(row);
  return c;
}

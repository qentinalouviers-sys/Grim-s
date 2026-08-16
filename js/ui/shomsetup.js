/* ==========================================================================
 * ui/shomsetup.js — brancher la carte marine officielle
 * --------------------------------------------------------------------------
 * Trois étapes, dans cet ordre : la clé, l'essai, le choix de la couche. On ne
 * demande jamais à l'utilisateur de deviner un nom de couche ni de composer
 * une URL — c'est le service qui déclare ce qu'il sert, et l'écran présente ce
 * qu'il a répondu.
 *
 * ── L'ESSAI EST UNE ÉTAPE À PART, ET C'EST VOULU ──────────────────────────
 * Une clé refusée, un réseau coupé, un service en maintenance : trois causes
 * différentes pour un même symptôme — une carte vide. Tant qu'on n'a pas
 * interrogé le service, on ne peut rien dire d'utile. L'écran interroge donc
 * AVANT d'enregistrer, et rapporte ce qu'il a obtenu, adresse par adresse.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as shom from '../data/shomchart.js';
import { emit } from '../core/store.js';

export function openShomSetup({ onSaved } = {}) {
  const body = el('div');
  const cur = shom.config();

  /* ---- Ce que c'est, et ce que ça engage -------------------------------- */
  body.append(el('p', 'muted',
    'La carte marine officielle du SHOM : sondes, isobathes, nature du fond, balisage et dangers. '
    + 'Elle demande une clé personnelle, gratuite, à demander sur data.shom.fr.'));

  const lic = el('div', 'banner info');
  lic.append(el('span', null,
    'La licence SHOM exclut l’exploitation commerciale : tant que l’app reste gratuite et sans '
    + 'publicité, l’usage est couvert. La clé est personnelle et reste sur cet appareil — elle '
    + 'n’est jamais envoyée ailleurs qu’au SHOM.'));
  body.append(lic);

  /* ---- 1. La clé -------------------------------------------------------- */
  const field = el('div', 'field');
  field.append(el('label', null, 'Clé data.shom.fr'));
  const input = document.createElement('input');
  input.type = 'text';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'colle ta clé ici';
  input.value = cur?.key || '';
  field.append(input);
  body.append(field);

  const report = el('div', 'tiny');
  body.append(report);

  /* ---- 2. Le choix de la couche ----------------------------------------- */
  const listCard = el('div', 'card flush');
  listCard.hidden = true;
  body.append(listCard);

  let found = null;

  const paintLayers = (endpoint, layers) => {
    clear(listCard);
    listCard.hidden = false;
    listCard.append(el('div', 'list-section', `${layers.length} couche${layers.length > 1 ? 's' : ''} servie${layers.length > 1 ? 's' : ''} — choisis la carte marine`));
    for (const lay of layers) {
      const row = el('button', 'list-item');
      row.type = 'button';
      const main = el('div', 'list-main');
      main.append(el('div', 'list-title', lay.title));
      main.append(el('div', 'list-sub',
        `${lay.id} · ${lay.format.replace('image/', '')} · ${lay.matrixIds.length} niveaux`));
      row.append(main, el('span', 'chev', '›'));
      row.addEventListener('click', async () => {
        const conf = await shom.save({
          key: input.value.trim(),
          endpoint,
          layer: lay.id,
          title: lay.title,
          style: lay.style,
          format: lay.format,
          matrixSet: lay.matrixSet,
          matrixIds: lay.matrixIds,
          template: lay.template,
          // Éteint par défaut : voir la note de licence ci-dessous.
          cache: !!cur?.cache,
        });
        closeSheet();
        toast(`Carte SHOM : ${lay.title}`, 'good');
        emit('shom:changed', conf);
        onSaved?.(conf);
      });
      listCard.append(row);
    }
  };

  /* ---- L'essai ---------------------------------------------------------- */
  const test = button('Interroger le service', 'btn-primary btn-lg', async () => {
    const key = input.value.trim();
    if (!key) return void toast('Colle d’abord ta clé', 'warn');
    report.textContent = 'Interrogation…';
    listCard.hidden = true;
    const r = await shom.discover(key);
    if (!r.layers.length) {
      report.className = 'tiny c-red';
      report.textContent = `Aucune couche obtenue. ${r.error || ''}`;
      return;
    }
    found = r;
    report.className = 'tiny';
    report.textContent = `Service joint sur ${r.endpoint}.`;
    paintLayers(r.endpoint, r.layers);
  });
  test.style.marginTop = '4px';
  body.append(test);

  /* ---- 3. Le cache hors ligne, et l'honnêteté qui va avec --------------- */
  if (cur) {
    const cacheRow = el('button', `fm-toggle${cur.cache ? ' on' : ''}`);
    cacheRow.type = 'button';
    const txt = el('div');
    txt.append(el('div', 'fm-toggle-n', 'Garder les tuiles hors ligne'));
    txt.append(el('div', 'fm-toggle-h',
      'Éteint par défaut. Conserver sur le disque une carte sous licence dépend des conditions '
      + 'attachées à ta clé — c’est à toi de les lire, pas à l’app de décider pour toi.'));
    const box = el('span', 'fm-toggle-box', '✓');
    cacheRow.append(txt, box);
    cacheRow.addEventListener('click', async () => {
      const conf = await shom.save({ cache: !shom.config()?.cache });
      cacheRow.classList.toggle('on', !!conf.cache);
      emit('shom:changed', conf);
    });
    body.append(cacheRow);

    const off = button('Retirer la carte SHOM', 'btn-sm', async () => {
      await shom.forget();
      closeSheet();
      toast('Carte SHOM retirée');
      emit('shom:changed', null);
      onSaved?.(null);
    });
    off.style.marginTop = '10px';
    body.append(off);
  }

  body.append(el('p', 'tiny',
    'Comment obtenir la clé : crée un compte sur data.shom.fr, puis demande un accès aux flux '
    + 'WMTS depuis ton espace. Le SHOM répond par une clé à coller ici. '
    + 'La carte officielle ne remplace pas les documents nautiques du bord.'));

  setTimeout(() => input.focus(), 80);
  return openSheet('Carte marine SHOM', body);
}

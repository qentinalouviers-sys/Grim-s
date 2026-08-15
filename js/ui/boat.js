/* ==========================================================================
 * ui/boat.js — fiche du bateau
 * --------------------------------------------------------------------------
 * Le formulaire qui deviendra la création de compte. Il est écrit dès
 * maintenant avec les champs définitifs — nom, coque, taille, motorisation,
 * types de pêche — pour deux raisons :
 *
 *   1. ils servent DÉJÀ : le nom part dans le message MAYDAY, la coque et la
 *      taille donnent une limite de mer et de vent qui ne sont pas les mêmes
 *      pour un semi-rigide de 5 m et une coque dure de 8 m ;
 *   2. le jour où un serveur existe, il n'y a rien à ressaisir.
 *
 * Il n'y a pas de champ mot de passe, et c'est un refus assumé : sans serveur
 * à qui le prouver, un mot de passe stocké sur le téléphone ne protège rien et
 * fabrique une confiance fausse. Voir core/profile.js.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as profile from '../core/profile.js';

export function openBoatForm({ onSaved = null } = {}) {
  const p = profile.get();
  const draft = {
    boatName: p.boatName || '',
    hull: p.hull,
    lengthM: p.lengthM,
    propulsion: p.propulsion,
    powerHp: p.powerHp,
    pob: p.pob,
    fishing: [...(p.fishing || [])],
  };

  const body = el('div');
  const summary = el('div', 'tiny');

  /* ---- Nom -------------------------------------------------------------- */
  const f1 = el('div', 'field');
  f1.append(el('label', null, 'Nom du bateau'));
  const name = document.createElement('input');
  name.type = 'text';
  name.value = draft.boatName;
  name.placeholder = 'Ex. Grim’s';
  name.autocapitalize = 'words';
  name.addEventListener('input', () => {
    draft.boatName = name.value;
    paint();
  });
  f1.append(name);
  body.append(f1);
  body.append(el('p', 'tiny', 'C’est ce nom qui part à la VHF dans le message de détresse, et celui qui identifiera le bateau dans la communauté.'));

  /* ---- Coque ------------------------------------------------------------ */
  body.append(el('div', 'field-label', 'Type de coque'));
  const hullBox = el('div', 'choice-grid');
  for (const h of profile.HULL_TYPES) {
    const b = el('button', 'choice');
    b.type = 'button';
    b.append(el('div', 'choice-name', h.name), el('div', 'choice-hint', h.hint));
    b.addEventListener('click', () => {
      draft.hull = draft.hull === h.id ? null : h.id;
      paint();
    });
    b.dataset.hull = h.id;
    hullBox.append(b);
  }
  body.append(hullBox);

  /* ---- Taille et puissance ---------------------------------------------- */
  const row = el('div', 'grid-2');
  const fLen = el('div', 'field');
  fLen.append(el('label', null, 'Longueur (m)'));
  const len = document.createElement('input');
  len.type = 'number';
  len.inputMode = 'decimal';
  len.step = '0.1';
  len.min = '2';
  len.max = '30';
  len.value = draft.lengthM ?? '';
  len.placeholder = '6,5';
  len.addEventListener('input', () => {
    draft.lengthM = len.value ? Number(len.value.replace(',', '.')) : null;
    paint();
  });
  fLen.append(len);

  const fPob = el('div', 'field');
  fPob.append(el('label', null, 'Personnes à bord'));
  const pob = document.createElement('input');
  pob.type = 'number';
  pob.inputMode = 'numeric';
  pob.min = '1';
  pob.max = '30';
  pob.value = draft.pob ?? '';
  pob.addEventListener('input', () => {
    draft.pob = pob.value ? Number(pob.value) : null;
  });
  fPob.append(pob);
  row.append(fLen, fPob);
  body.append(row);

  /* ---- Motorisation ----------------------------------------------------- */
  body.append(el('div', 'field-label', 'Motorisation'));
  const propBox = el('div', 'row wrap');
  for (const m of profile.PROPULSIONS) {
    const b = el('button', 'chip chip-btn', m.name);
    b.type = 'button';
    b.dataset.prop = m.id;
    b.addEventListener('click', () => {
      draft.propulsion = draft.propulsion === m.id ? null : m.id;
      paint();
    });
    propBox.append(b);
  }
  body.append(propBox);

  const fHp = el('div', 'field');
  fHp.style.marginTop = '10px';
  fHp.append(el('label', null, 'Puissance (ch)'));
  const hp = document.createElement('input');
  hp.type = 'number';
  hp.inputMode = 'numeric';
  hp.min = '2';
  hp.max = '600';
  hp.value = draft.powerHp ?? '';
  hp.placeholder = '115';
  hp.addEventListener('input', () => {
    draft.powerHp = hp.value ? Number(hp.value) : null;
  });
  fHp.append(hp);
  body.append(fHp);

  /* ---- Types de pêche --------------------------------------------------- */
  body.append(el('div', 'field-label', 'Types de pêche pratiqués'));
  const fishBox = el('div', 'row wrap');
  for (const f of profile.FISHING_TYPES) {
    const b = el('button', 'chip chip-btn', f.name);
    b.type = 'button';
    b.dataset.fish = f.id;
    b.addEventListener('click', () => {
      const i = draft.fishing.indexOf(f.id);
      if (i >= 0) draft.fishing.splice(i, 1);
      else draft.fishing.push(f.id);
      paint();
    });
    fishBox.append(b);
  }
  body.append(fishBox);

  /* ---- Ce que ça change ------------------------------------------------- */
  body.append(el('div', 'hr'));
  body.append(summary);

  body.append(button('Enregistrer', 'btn-primary btn-lg', async () => {
    if (!draft.boatName.trim()) return void toast('Il faut au moins un nom de bateau', 'danger');
    const saved = await profile.save({ ...draft, boatName: draft.boatName.trim() });
    closeSheet();
    toast('Fiche bateau enregistrée', 'good');
    onSaved?.(saved);
  }));

  function paint() {
    for (const b of hullBox.querySelectorAll('[data-hull]')) {
      b.classList.toggle('on', b.dataset.hull === draft.hull);
    }
    for (const b of propBox.querySelectorAll('[data-prop]')) {
      b.classList.toggle('good', b.dataset.prop === draft.propulsion);
    }
    for (const b of fishBox.querySelectorAll('[data-fish]')) {
      b.classList.toggle('good', draft.fishing.includes(b.dataset.fish));
    }
    const c = profile.comfort({ ...profile.get(), ...draft });
    summary.textContent = draft.lengthM
      ? `Avec ces caractéristiques, l’app considère comme confortable une mer jusqu’à ${String(c.seaLimitM).replace('.', ',')} m `
        + `et un vent jusqu’à ${c.windLimitKn} nd. Au-delà, elle le dira dans le conseil. `
        + `Ces seuils sont indicatifs : c’est toi le chef de bord.`
      : 'Renseigne la longueur et la coque : l’app en déduit une limite de mer et de vent adaptée au bateau plutôt qu’un seuil unique pour tout le monde.';
  }

  paint();
  return openSheet('Mon bateau', body);
}

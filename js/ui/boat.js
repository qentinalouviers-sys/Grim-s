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

import { el, clear, button, toast, openSheet, closeSheet, decimalInput } from './dom.js';
import * as profile from '../core/profile.js';

/**
 * @param {object}   opts
 * @param {Function} opts.onSaved   appelé avec le profil enregistré
 * @param {boolean}  opts.firstRun  première configuration, juste après la
 *   création du compte : le ton change, un mot explique pourquoi on demande
 *   tout ça, et « Plus tard » apparaît. Ce n'est pas un questionnaire
 *   administratif — chaque champ sert à quelque chose, et l'écran doit le dire
 *   plutôt que de laisser croire à une formalité.
 */
/**
 * Libellé de champ, avec son statut.
 *
 * Marquer chaque champ vaut mieux qu'un « tous les champs sont obligatoires »
 * en tête d'écran : cette phrase-là se lit une fois puis disparaît de la
 * mémoire, alors que la mention reste sous les yeux au moment de remplir.
 * Et le facultatif est marqué AUSSI — sans quoi on cherche ce qui manque
 * parmi les champs qu'on avait le droit de laisser vides.
 */
function lbl(text, required = true) {
  const l = el('label', null, text);
  l.append(el('span', required ? 'req' : 'opt', required ? ' obligatoire' : ' facultatif'));
  return l;
}

export function openBoatForm({ onSaved = null, firstRun = false } = {}) {
  const p = profile.get();
  const draft = {
    boatName: p.boatName || '',
    immat: p.immat || '',
    mmsi: p.mmsi || '',
    hull: p.hull,
    lengthM: p.lengthM,
    propulsion: p.propulsion,
    powerHp: p.powerHp,
    pob: p.pob,
    fishing: [...(p.fishing || [])],
  };

  const body = el('div');
  const summary = el('div', 'tiny');

  if (firstRun) {
    body.append(el('p', 'tiny',
      'Une seule fois, et l’app travaille ensuite pour ce bateau-là. Le nom part '
      + 'dans le message de détresse ; la coque et la longueur décident de ce que '
      + 'l’app considère comme une mer praticable — une mer de 1,2 m ne veut pas '
      + 'dire la même chose sous un semi-rigide de 5 m et sous une coque dure de 8 m.'));
    body.append(el('div', 'hr'));
  }

  /* ---- Nom -------------------------------------------------------------- */
  const f1 = el('div', 'field');
  f1.append(lbl('Nom du bateau'));
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

  /* ---- Immatriculation et MMSI ------------------------------------------
   * Deux identifiants, deux usages distincts. L'immatriculation est peinte sur
   * la coque : c'est elle que demandent les affaires maritimes et le CROSS
   * quand quelqu'un signale un bateau. Le MMSI est celui de la VHF ASN : s'il
   * est renseigné, un appel de détresse numérique porte l'identité du bateau
   * sans que personne ait à parler — ce qui compte exactement au moment où on
   * n'a plus les mains libres.
   *
   * Les deux sont facultatifs, et le disent. Un champ obligatoire qu'on ne
   * connaît pas par cœur fait abandonner le formulaire entier.            */
  const fImm = el('div', 'field');
  fImm.append(lbl('Immatriculation'));
  const immat = document.createElement('input');
  immat.type = 'text';
  immat.value = draft.immat;
  immat.placeholder = 'Ex. DP 123456';
  immat.autocapitalize = 'characters';
  immat.autocorrect = 'off';
  immat.spellcheck = false;
  immat.addEventListener('input', () => { draft.immat = immat.value; });
  fImm.append(immat);
  body.append(fImm);

  const fMmsi = el('div', 'field');
  fMmsi.append(lbl('MMSI de la VHF', false));
  const mmsi = document.createElement('input');
  mmsi.type = 'text';
  mmsi.inputMode = 'numeric';
  mmsi.value = draft.mmsi;
  mmsi.placeholder = '9 chiffres — si tu as une VHF ASN';
  mmsi.maxLength = 9;
  mmsi.addEventListener('input', () => {
    // Seulement des chiffres : un MMSI mal saisi ne sert à rien, et le corriger
    // à la volée évite de faire échouer l'enregistrement sur une faute de frappe.
    mmsi.value = mmsi.value.replace(/\D/g, '').slice(0, 9);
    draft.mmsi = mmsi.value;
  });
  fMmsi.append(mmsi);
  body.append(fMmsi);
  body.append(el('p', 'tiny',
    'Facultatifs tous les deux. L’immatriculation identifie le bateau auprès du '
    + 'CROSS ; le MMSI permet à la VHF de lancer un appel de détresse numérique '
    + 'sans avoir à parler.'));

  /* ---- Coque ------------------------------------------------------------ */
  body.append(el('div', 'field-label', 'Type de coque'));
  body.append(el('div', 'tiny req-note', 'obligatoire'));
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
  fLen.append(lbl('Longueur (m)'));
  /* Champ TEXTE et non `number` : sur un clavier français, « 6,5 » tapé dans
   * un `type="number"` ressort à « 65 » — la virgule est avalée avant que le
   * code la voie. C'est ce qui laissait la longueur vide, et donc la fiche
   * réputée incomplète alors qu'elle était remplie. Voir `ui/dom.js`. */
  const len = decimalInput({
    value: draft.lengthM,
    placeholder: '6,5',
    onInput: (n) => { draft.lengthM = n; paint(); },
  });
  fLen.append(len);

  const fPob = el('div', 'field');
  fPob.append(lbl('Personnes à bord'));
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
  body.append(el('div', 'tiny req-note', 'obligatoire'));
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
  fHp.append(lbl('Puissance (ch)'));
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
  body.append(el('div', 'tiny opt-note', 'facultatif — affine le conseil'));
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

  body.append(button(firstRun ? 'Continuer' : 'Enregistrer', 'btn-primary btn-lg', async () => {
    /* On refuse en NOMMANT ce qui manque. « Il faut au moins un nom » laissait
     * croire que le reste était accessoire, alors que la longueur conditionne
     * les seuils de mer et que l'immatriculation part dans le MAYDAY. */
    const manque = profile.missing({ ...draft, boatName: draft.boatName.trim() });
    if (manque.length) {
      return void toast(`Il manque ${manque.slice(0, 2).join(' et ')}${manque.length > 2 ? ` (+${manque.length - 2})` : ''}.`, 'danger');
    }
    const saved = await profile.save({
      ...draft,
      boatName: draft.boatName.trim(),
      immat: draft.immat.trim().toUpperCase(),
      mmsi: draft.mmsi.trim(),
    });
    closeSheet();
    toast(firstRun ? `Bienvenue à bord, ${saved.boatName}.` : 'Fiche bateau enregistrée', 'good');
    onSaved?.(saved);
  }));

  /* « Plus tard » n'existe qu'à la première configuration, et il existe pour de
   * bon : bloquer quelqu'un derrière un formulaire dans une app qui porte un
   * bouton SOS serait un mauvais échange. La fiche reste accessible depuis les
   * réglages, et l'écran de détresse redemande ce qui lui manque au moment où
   * il en a besoin. */
  if (firstRun) {
    body.append(button('Plus tard', 'btn-ghost', () => {
      closeSheet();
      toast('Tu pourras remplir la fiche à tout moment depuis les réglages.', '');
      onSaved?.(null);
    }));
  }

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
  return openSheet(firstRun ? 'Ton bateau' : 'Mon bateau', body);
}

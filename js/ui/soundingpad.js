/* ==========================================================================
 * ui/soundingpad.js — noter une sonde en deux touchers
 * --------------------------------------------------------------------------
 * On sonde en dérivant, une main sur la canne. Le geste doit tenir en deux
 * touchers et ne jamais demander de viser petit.
 *
 * ── POURQUOI PAS UN CLAVIER ───────────────────────────────────────────────
 * Un champ numérique ouvre le clavier système, qui recouvre les deux tiers de
 * l'écran, met une seconde à apparaître, et laisse passer « 144 » pour « 14,4 ».
 * Un pas de cinquante centimètres autour de la dernière valeur couvre le cas
 * réel : sur une dérive, la sonde bouge de quelques mètres, pas de cinquante.
 *
 * ── LA MÉMOIRE DE LA DERNIÈRE VALEUR EST LE CŒUR DU GESTE ─────────────────
 * Le pad s'ouvre sur la sonde précédente. Sur un ridin qui monte de 18 à 14,
 * ce sont huit appuis sur « − » et un sur « noter » — ou, plus souvent, un
 * appui sur la pastille « 14 » de la rangée rapide. Repartir de zéro à chaque
 * fois rendrait le relevé si pénible qu'on ne relèverait rien, et un carnet de
 * sondes vide ne vaut rien.
 *
 * ── CE QUI EST ÉCRIT À L'ÉCRAN, ET POURQUOI ───────────────────────────────
 * La hauteur de marée du moment, et la sonde ramenée au zéro des cartes. Ce
 * n'est pas de la décoration : c'est ce qui rend le relevé comparable d'une
 * sortie à l'autre, et le voir une fois suffit à comprendre pourquoi le même
 * caillou affichait 9 m un jour et 18 m un autre.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import { state } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import * as tide from '../data/tide.js';
import * as soundings from '../fishing/soundings.js';

const STEP = 0.5;
/* Les sondes où l'on pêche vraiment en Manche orientale. La rangée rapide
 * évite la dizaine d'appuis quand on saute d'un poste à l'autre. */
const QUICK = [6, 8, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40];

let lastValue = 14;

/**
 * @param {object} [opts]
 * @param {Function} [opts.onSaved] Appelé avec la sonde enregistrée.
 */
export function openSoundingPad({ onSaved } = {}) {
  const body = el('div');

  if (!state.fix) {
    body.append(el('p', 'muted',
      'Pas de position GPS : une sonde sans position ne vaut rien, elle ne se retrouve pas. '
      + 'Attends le point, le bouton reviendra.'));
    return openSheet('Noter une sonde', body);
  }

  let value = lastValue;

  /* ---- Le chiffre, en grand ---------------------------------------------- */
  const big = el('div', 'sp-big');
  const readout = el('div', 'sp-read');

  const paint = () => {
    clear(big);
    big.append(el('span', 'sp-val tnum', value.toFixed(1).replace('.0', '')),
      el('span', 'sp-unit', 'm'));

    const h = tide.height(Date.now());
    const offset = Number(state.profile?.sounderOffsetM) || 0;
    const zero = value + offset - h;
    clear(readout);
    readout.append(el('div', 'sp-read-l',
      `marée ${fmt.num(h, 2)} m${offset ? ` · sonde +${fmt.num(offset, 2)} m` : ''}`));
    readout.append(el('div', 'sp-read-v',
      `= ${fmt.num(zero, 1)} m au zéro des cartes`));
    /* Le zéro des cartes est la seule valeur comparable d'une sortie à
     * l'autre. On l'écrit sous le chiffre brut plutôt que dans une aide que
     * personne n'ouvre. */
    if (!offset) {
      readout.append(el('div', 'sp-read-n',
        'Le tirant d’eau de ta sonde n’est pas renseigné : les relevés sont donc un peu faibles. Fiche bateau → « sonde ».'));
    }
  };

  body.append(big, readout);

  /* ---- Moins / plus, en grand -------------------------------------------- */
  const step = el('div', 'sp-step');
  const mk = (txt, delta) => {
    const b = el('button', 'sp-pm');
    b.type = 'button';
    b.textContent = txt;
    const bump = () => {
      value = Math.min(soundings.MAX_M, Math.max(soundings.MIN_M, +(value + delta).toFixed(1)));
      paint();
      navigator.vibrate?.(6);
    };
    b.addEventListener('click', bump);
    /* Appui maintenu : sur un fond qui plonge de vingt mètres, appuyer
     * quarante fois n'est pas une interface. */
    let hold = 0;
    let rep = 0;
    const start = () => {
      hold = setTimeout(() => { rep = setInterval(bump, 90); }, 420);
    };
    const stop = () => { clearTimeout(hold); clearInterval(rep); };
    b.addEventListener('pointerdown', start);
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
    return b;
  };
  step.append(mk('−', -STEP), mk('+', STEP));
  body.append(step);

  /* ---- Rangée rapide ------------------------------------------------------ */
  const quick = el('div', 'sp-quick');
  for (const q of QUICK) {
    const b = el('button', 'sp-q');
    b.type = 'button';
    b.textContent = String(q);
    b.addEventListener('click', () => { value = q; paint(); });
    quick.append(b);
  }
  body.append(el('div', 'sp-lbl', 'RACCOURCIS'), quick);

  /* ---- Ce qu'on a vu ------------------------------------------------------ */
  const noteWrap = el('div', 'sp-notes');
  let note = '';
  for (const n of ['ridin', 'tombant', 'fosse', 'roche', 'épave', 'plat']) {
    const b = el('button', 'sp-note');
    b.type = 'button';
    b.textContent = n;
    b.addEventListener('click', () => {
      note = note === n ? '' : n;
      for (const x of noteWrap.children) x.classList.toggle('on', x.textContent === note);
    });
    noteWrap.append(b);
  }
  body.append(el('div', 'sp-lbl', 'CE QUE TU VOIS (facultatif)'), noteWrap);

  /* ---- Noter -------------------------------------------------------------- */
  const save = button('Noter cette sonde', 'btn-primary btn-lg', async () => {
    const s = await soundings.add({ rawM: value, note });
    if (!s) return void toast('Sonde refusée — position ou valeur hors limites', 'danger');
    lastValue = value;
    closeSheet();
    navigator.vibrate?.([25, 40, 25]);
    toast(`Sonde notée : ${s.zeroM != null ? `${s.zeroM} m au zéro` : `${s.rawM} m brut`}`, 'good');
    onSaved?.(s);
  });
  save.style.marginTop = '12px';
  body.append(save);

  const n = soundings.count();
  body.append(el('div', 'tiny',
    n ? `${n} sonde${n > 1 ? 's' : ''} au carnet. Elles servent au scoring des postes et priment sur le modèle public.`
      : 'Première sonde. Le carnet sert au scoring des postes et prime sur le modèle public, qui ne voit pas le ridin.'));

  paint();
  return openSheet('Noter une sonde', body);
}

/** La dernière valeur saisie — pour que l'appelant l'affiche s'il veut. */
export const lastEntered = () => lastValue;

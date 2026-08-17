/* ==========================================================================
 * ui/sos.js — écran de détresse
 * --------------------------------------------------------------------------
 * ── CE QUE CE BOUTON NE FAIT PAS, ET POURQUOI ─────────────────────────────
 *
 * Il ne déclenche PAS le « SOS d'urgence » d'iOS ni celui d'Android. Aucune
 * page web ne le peut : ces fonctions sont câblées sur les boutons physiques
 * de l'appareil et ne sont exposées à aucune API — délibérément, sinon
 * n'importe quel site appellerait les secours. On l'écrit sur l'écran plutôt
 * que de laisser croire à un bouton magique, et on rappelle la combinaison de
 * touches, qui est la seule façon de déclencher le SOS natif.
 *
 * ── CE QU'IL FAIT, ET POURQUOI C'EST PLUS UTILE EN MER ────────────────────
 *
 * En détresse, ce qui coûte du temps n'est pas de composer un numéro : c'est
 * de DIRE OÙ ON EST. Une position lue de travers sur un écran qui bouge, c'est
 * un hélicoptère qui cherche au mauvais endroit. Cet écran met donc en premier
 * la position en degrés-minutes décimales — la seule forme qui se lit à voix
 * haute sans erreur — et l'accroche à trois canaux :
 *
 *   VHF canal 16   la voie officielle en mer, et la seule qui prévienne aussi
 *                  les navires alentour, souvent plus proches que les secours.
 *                  Le message MAYDAY est pré-rédigé, prêt à être lu.
 *   196            le numéro des secours EN MER : il tombe directement sur le
 *                  CROSS. Le 112 tombe sur les secours terrestres, qui doivent
 *                  ensuite transférer — quelques minutes de plus, à chaque fois.
 *   SMS / partage  pour prévenir quelqu'un à terre, avec la position dedans.
 *
 * Le tout fonctionne sans réseau de données : les numéros sont composés par le
 * réseau téléphonique, et le message MAYDAY est calculé à bord.
 * ========================================================================== */

import { state, set, emit } from '../core/store.js';
import { el, clear, button, toast } from './dom.js';
import * as fmt from '../core/fmt.js';
import * as idb from '../core/idb.js';
import * as tide from '../data/tide.js';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let screenNode = null;
let timer = 0;
/** Position figée à l'appui : elle continue de dériver pendant qu'on parle. */
let frozen = null;

export function isOpen() {
  return !!screenNode;
}

export function openSOS() {
  if (screenNode) return;
  navigator.vibrate?.([80, 50, 80]);
  // Les bateaux du secteur équipés de l'app verront le pavillon de détresse,
  // même si le partage de position est éteint. C'est délibéré et annoncé.
  emit('sos:open');
  frozen = state.fix ? { ...state.fix, t: Date.now() } : null;

  screenNode = el('div', 'sos-screen');
  document.body.append(screenNode);
  render();
  // La position vit : on la rafraîchit, mais on garde celle du déclenchement
  // affichée à part. Les deux comptent — l'une pour être trouvé maintenant,
  // l'autre pour reconstituer la dérive si la liaison se coupe.
  timer = setInterval(render, 2000);
}

export function closeSOS() {
  clearInterval(timer);
  timer = 0;
  screenNode?.remove();
  screenNode = null;
}

/* --------------------------------------------------------------------------
 * Rendu
 * ------------------------------------------------------------------------ */
function render() {
  if (!screenNode) return;
  const box = clear(screenNode);
  const fix = state.fix;
  const settings = state.settings || {};

  /* ---- Titre ------------------------------------------------------------ */
  const head = el('div', 'sos-head');
  head.append(el('div', 'sos-title', 'DÉTRESSE'));
  const close = el('button', 'icon-btn', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer');
  close.addEventListener('click', closeSOS);
  head.append(el('div', 'spacer'), close);
  box.append(head);

  /* ---- Position --------------------------------------------------------- */
  const posCard = el('div', 'sos-pos');
  if (fix) {
    posCard.append(el('div', 'sos-lbl', 'MA POSITION — À LIRE TELLE QUELLE'));
    posCard.append(el('div', 'sos-coord', fmt.latDDM(fix.lat)));
    posCard.append(el('div', 'sos-coord', fmt.lonDDM(fix.lon)));
    posCard.append(el('div', 'tiny',
      `± ${Math.round(fix.accuracy || 0)} m · ${fmt.age(fix.t)}`
      + (fix.moving ? ` · route ${fmt.heading(fix.cogDeg)} à ${fmt.num(fix.speedKn, 1)} nd` : '')));
    if (frozen && distanceRough(frozen, fix) > 40) {
      posCard.append(el('div', 'tiny',
        `Position au déclenchement (${fmt.hhmmss(frozen.t)}) : ${fmt.posDDM(frozen)}`));
    }
  } else {
    posCard.append(el('div', 'sos-lbl', 'POSITION INDISPONIBLE'));
    posCard.append(el('div', 'muted',
      "Pas de fix GPS. Donne ta position par rapport à un amer connu, ou l'heure et le cap depuis ton dernier point sûr."));
  }
  box.append(posCard);

  const copyRow = el('div', 'btn-row');
  copyRow.append(
    button('📋 Copier', '', () => copy(fmt.posDDM(fix || frozen))),
    button('📤 Partager', '', sharePosition),
    smsLink(),
  );
  box.append(copyRow);

  /* ---- Appels ----------------------------------------------------------- *
   * De vrais liens <a>, et pas un location.href : dans une PWA installée en
   * plein écran, iOS ignore silencieusement une navigation `tel:` faite par
   * script. Le lien, lui, ouvre le composeur. */
  box.append(callLink('196', '📞 196 — SECOURS EN MER', 'CROSS · secours maritime, directement', 'sos-call-main'));
  box.append(callLink('112', '📞 112 — urgences', 'Européen · transfère au CROSS', 'sos-call'));

  /* ---- VHF -------------------------------------------------------------- */
  box.append(vhfCard(fix, settings));

  /* ---- SOS natif -------------------------------------------------------- */
  const nat = el('div', 'sos-note');
  nat.append(el('div', 'list-title', 'SOS du téléphone'));
  nat.append(el('div', 'list-sub', IS_IOS
    ? 'iPhone : maintiens le bouton latéral ET un bouton de volume, puis fais glisser « Appel d’urgence ». Ou cinq appuis rapides sur le bouton latéral.'
    : 'Android : cinq appuis rapides sur le bouton marche/arrêt (selon la marque). À vérifier dans Réglages → Sécurité et urgence.'));
  nat.append(el('div', 'tiny',
    'Cette fonction appartient au téléphone : aucune application web ne peut la déclencher. '
    + 'Elle prévient tes contacts d’urgence avec ta position — utile en complément, pas à la place du canal 16.'));
  box.append(nat);

  /* ---- Rappel ----------------------------------------------------------- */
  box.append(el('div', 'tiny',
    'Reste sur l’eau si le bateau flotte encore : un navire est plus visible qu’une tête. '
    + 'Gilets enfilés, fusées à portée de main, et quelqu’un en observation permanente sur toute personne à l’eau.'));

  const stop = button('Fermer', 'btn-ghost btn-lg', closeSOS);
  stop.style.marginTop = '10px';
  box.append(stop);
}

/* --------------------------------------------------------------------------
 * Message MAYDAY
 * --------------------------------------------------------------------------
 * Le format international, dans l'ordre où les secours l'attendent. Pré-rempli
 * avec la position et le nom du bateau : sous adrénaline, on ne compose pas un
 * message, on lit celui qui est écrit.
 * ------------------------------------------------------------------------ */
export function maydayText(fix, settings = {}) {
  const boat = (settings.boatName || 'NOM DU BATEAU').toUpperCase();
  const pob = settings.pob ? `${settings.pob} personne${settings.pob > 1 ? 's' : ''} à bord` : 'NOMBRE DE PERSONNES À BORD';
  const pos = fix ? `${fmt.latDDM(fix.lat)} ${fmt.lonDDM(fix.lon)}` : 'POSITION';

  /* L'immatriculation n'apparaît que si elle est connue. Une ligne
   * « IMMATRICULATION » en majuscules d'attente, au milieu d'un message qu'on
   * lit à voix haute sous adrénaline, ferait buter sur un mot inutile : le nom
   * du bateau suffit à s'identifier, l'immatriculation ne fait que confirmer. */
  const ident = settings.immat
    ? `Ici ${boat}, immatriculé ${String(settings.immat).toUpperCase()}`
    : `Ici ${boat}, ${boat}, ${boat}`;

  return [
    'MAYDAY MAYDAY MAYDAY',
    ident,
    `MAYDAY ${boat}`,
    `Ma position : ${pos}`,
    'Nature de la détresse : (voie d’eau / incendie / homme à la mer / échouement)',
    'Je demande une assistance immédiate',
    pob,
    'À vous',
  ].join('\n');
}

function vhfCard(fix, settings) {
  const card = el('div', 'sos-vhf');
  const head = el('div', 'row');
  head.append(el('div', 'list-title', '📻 VHF — CANAL 16'));
  head.append(el('div', 'spacer'));
  const edit = el('button', 'chip chip-btn', '⚙︎ Bateau');
  edit.type = 'button';
  edit.addEventListener('click', boatForm);
  head.append(edit);
  card.append(head);

  card.append(el('div', 'tiny',
    'La VHF prévient les secours ET les navires autour de toi, souvent plus proches. Lis ceci, lentement, deux fois.'));

  const pre = el('div', 'sos-script', maydayText(fix, settings));
  card.append(pre);

  card.append(button('📋 Copier le message', 'btn-sm', () => copy(maydayText(fix, settings))));
  card.append(el('div', 'tiny',
    'Détresse non vitale (panne, remorquage) : dis PAN PAN trois fois au lieu de MAYDAY, même suite.'));
  return card;
}

/**
 * Nom du bateau et personnes à bord. Deux champs, demandés une seule fois,
 * qui font la différence entre un message complet et un message qu'on
 * improvise au moment où l'on improvise le plus mal.
 */
function boatForm() {
  const s = state.settings || {};
  const body = el('div', 'sos-form');
  body.append(el('div', 'list-title', 'Identité du bateau'));

  const f1 = el('div', 'field');
  f1.append(el('label', null, 'Nom du bateau'));
  const name = document.createElement('input');
  name.type = 'text';
  name.value = s.boatName || '';
  name.placeholder = 'Ex. Grim’s';
  f1.append(name);

  const f2 = el('div', 'field');
  f2.append(el('label', null, 'Personnes à bord'));
  const pob = document.createElement('input');
  pob.type = 'number';
  pob.inputMode = 'numeric';
  pob.min = '1';
  pob.max = '30';
  pob.value = s.pob || '';
  f2.append(pob);

  body.append(f1, f2);
  body.append(button('Enregistrer', 'btn-primary btn-lg', async () => {
    const settings = {
      ...(state.settings || {}),
      boatName: name.value.trim(),
      pob: Number(pob.value) || null,
    };
    set({ settings });
    await idb.put('kv', 'settings', settings);
    render();
  }));

  const host = screenNode.querySelector('.sos-vhf');
  host?.append(body);
  name.focus();
}

/* --------------------------------------------------------------------------
 * Liens système
 * ------------------------------------------------------------------------ */
function callLink(number, label, sub, cls) {
  const a = document.createElement('a');
  a.className = `sos-btn ${cls}`;
  a.href = `tel:${number}`;
  a.rel = 'nofollow';
  a.append(el('span', 'sos-btn-main', label));
  a.append(el('span', 'sos-btn-sub', sub));
  a.addEventListener('click', () => navigator.vibrate?.(30));
  return a;
}

/** Message prêt à envoyer à terre : position, heure, et de quoi rappeler. */
function distressSMS() {
  const fix = state.fix || frozen;
  const boat = state.settings?.boatName ? `${state.settings.boatName} — ` : '';
  const now = Date.now();
  return `${boat}DETRESSE. Position ${fix ? fmt.posDDM(fix) : 'inconnue'} a ${fmt.hhmm(now)}.`
    + ` Hauteur d'eau ${fmt.num(tide.height(now), 1)} m.`
    + ` Previens le CROSS au 196.`;
}

function smsLink() {
  const a = document.createElement('a');
  a.className = 'btn';
  a.style.flex = '1';
  // La syntaxe diffère : iOS veut « sms:&body= », Android « sms:?body= ».
  a.href = IS_IOS
    ? `sms:&body=${encodeURIComponent(distressSMS())}`
    : `sms:?body=${encodeURIComponent(distressSMS())}`;
  a.textContent = '✉️ SMS';
  return a;
}

async function sharePosition() {
  const txt = distressSMS();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Détresse en mer', text: txt });
      return;
    }
  } catch {
    return; // partage annulé par l'utilisateur : rien à signaler
  }
  copy(txt);
}

async function copy(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    toast('Copié', 'good');
  } catch {
    toast('Copie refusée par le navigateur');
  }
}

/** Distance approchée en mètres — suffisante pour décider d'un affichage. */
const distanceRough = (a, b) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * 0.64) * 111000;

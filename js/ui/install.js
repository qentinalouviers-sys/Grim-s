/* ==========================================================================
 * ui/install.js — installation sur l'écran d'accueil
 * --------------------------------------------------------------------------
 * Une app de mer qui n'est pas INSTALLÉE perd l'essentiel de ce qui la rend
 * utilisable à bord, et l'utilisateur ne le sait pas :
 *
 *   • l'onglet du navigateur mange 120 px de haut — sur un écran de 667 px
 *     c'est une jauge entière ;
 *   • le maintien de l'écran allumé est refusé ou révoqué plus vite ;
 *   • iOS purge le stockage d'un site simplement visité au bout de sept jours
 *     d'inactivité — donc les marques, les prises, les tuiles préchargées ;
 *   • le lancement hors réseau n'est garanti que pour une app installée.
 *
 * D'où une invitation explicite, mais discrète et non répétée : proposée une
 * fois, rappelée dans le JOURNAL, jamais imposée. Une bannière d'installation
 * qui revient à chaque ouverture est le meilleur moyen de faire désinstaller
 * une app avant même qu'elle soit installée.
 * ========================================================================== */

import { el, button, banner, dismissBanner, toast } from './dom.js';
import * as idb from '../core/idb.js';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let deferred = null;   // l'événement Android/Chrome, gardé pour plus tard

/** L'app tourne-t-elle déjà comme une app, et non comme un onglet ? */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || navigator.standalone === true;
}

/** Peut-on proposer quelque chose d'utile à cet utilisateur ? */
export const canOffer = () => !isStandalone() && (!!deferred || IS_IOS);

export function init() {
  window.addEventListener('beforeinstallprompt', (e) => {
    // On confisque la bannière du navigateur pour la proposer au bon moment,
    // au bon endroit, dans notre langue.
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    dismissBanner('install');
    idb.put('kv', 'installed', Date.now());
    toast('Grim’s est installé — il s’ouvrira désormais hors réseau', 'good', 5000);
  });
}

/**
 * Invitation unique, quelques secondes après le démarrage — jamais pendant la
 * séquence d'autorisation des capteurs, qui est déjà assez chargée.
 */
export async function maybeOffer() {
  if (isStandalone()) return;
  if (await idb.get('kv', 'installDismissed')) return;
  setTimeout(async () => {
    if (!canOffer()) return;
    // Deux lignes au plus : ce bandeau est une proposition, pas un cours.
    // Le détail est dans le JOURNAL, pour qui veut savoir pourquoi.
    const b = banner('Installer Grim’s sur l’écran d’accueil ?', 'info', { id: 'install' });
    if (!b) return;
    const go = button('Installer', 'btn-sm', () => prompt());
    b.querySelector('span')?.after(go);
    b.querySelector('.x')?.addEventListener('click', () => idb.put('kv', 'installDismissed', Date.now()));
  }, 6000);
}

/** Déclenche l'installation, ou explique le geste sur iOS qui ne l'expose pas. */
export async function prompt() {
  if (deferred) {
    deferred.prompt();
    const res = await deferred.userChoice.catch(() => null);
    deferred = null;
    if (res?.outcome === 'accepted') dismissBanner('install');
    return res?.outcome === 'accepted';
  }
  if (IS_IOS) {
    const { openSheet } = await import('./dom.js');
    const body = el('div');
    body.append(el('p', 'muted', 'iOS ne permet pas à un site de s’installer tout seul : le geste appartient à Safari, en trois touches.'));
    const steps = [
      ['1', 'Touche le bouton Partager, en bas de Safari (le carré avec la flèche).'],
      ['2', 'Fais défiler et choisis « Sur l’écran d’accueil ».'],
      ['3', 'Valide. Grim’s apparaît comme une application.'],
    ];
    for (const [n, txt] of steps) {
      const r = el('div', 'row');
      r.style.alignItems = 'flex-start';
      r.style.padding = '6px 0';
      const badge = el('div', 'score-badge', n);
      badge.style.background = 'var(--bg-2)';
      badge.style.minWidth = '34px';
      badge.style.height = '34px';
      r.append(badge, el('div', 'list-main', txt));
      body.append(r);
    }
    body.append(el('p', 'tiny',
      'Ce n’est pas cosmétique : une app installée démarre sans réseau, garde l’écran allumé plus longtemps, et iOS cesse d’effacer tes marques après sept jours sans ouverture.'));
    openSheet('Installer sur l’écran d’accueil', body);
    return false;
  }
  toast('Ton navigateur ne propose pas l’installation ici');
  return false;
}

/** Carte pour le JOURNAL — l'endroit où l'on range ce qui n'est pas urgent. */
export function card() {
  if (isStandalone()) {
    const c = el('div', 'card');
    const h = el('div', 'card-head');
    h.append(el('h3', null, 'APPLICATION'));
    c.append(h);
    c.append(el('div', 'list-title', '✓ Installée sur l’écran d’accueil'));
    c.append(el('div', 'list-sub', 'Démarrage hors réseau garanti, écran maintenu allumé, stockage durable.'));
    return c;
  }
  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.append(el('h3', null, 'INSTALLER L’APPLICATION'));
  c.append(h);
  c.append(el('p', 'muted',
    'Sur l’écran d’accueil, Grim’s gagne le plein écran, démarre sans réseau et conserve durablement tes marques et tes prises. Dans un onglet, iOS peut les effacer après sept jours sans ouverture.'));
  c.append(button('📲 Installer', 'btn-primary btn-lg', () => prompt()));
  return c;
}

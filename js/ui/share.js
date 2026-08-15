/* ==========================================================================
 * ui/share.js — passer l'app au bateau d'à côté
 * --------------------------------------------------------------------------
 * Le geste visé : deux bateaux bord à bord, moteurs au ralenti, six milles au
 * large. On tend son téléphone, l'autre le vise, il a l'app. Pas d'adresse à
 * épeler dans le vent, pas de nom à écrire sous la pluie, pas de réseau.
 *
 * Trois conséquences de ce scénario, et elles commandent tout le fichier :
 *
 * 1. LE CODE EST CALCULÉ À BORD (core/qr.js). Un QR fabriqué par un service en
 *    ligne ne s'affiche pas là où on en a besoin.
 * 2. CORRECTION MAXIMALE. Niveau H : jusqu'à 30 % du code peut être illisible
 *    — reflet du soleil, gouttes sur la vitre, doigt sur l'écran — et il se
 *    lit quand même. C'est aussi ce qui autorise l'ancre au centre.
 * 3. UN MODE PLEIN ÉCRAN. Blanc franc, code au maximum de la largeur : c'est
 *    le contraste qui décide, et l'écran d'un téléphone en plein soleil n'en a
 *    pas beaucoup à revendre.
 * ========================================================================== */

import { el, clear, button, toast, openSheet } from './dom.js';
import { encode } from '../core/qr.js';
import { APP_VERSION } from '../core/build.js';

/** L'URL de l'app, telle qu'elle est réellement servie. */
export function appUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/index\.html$/, '');
  return url.toString();
}

export function openShare() {
  const url = appUrl();
  const body = el('div');

  body.append(el('p', 'muted',
    'Fais viser ce code par le téléphone du bateau d’à côté : il ouvre l’app, qui s’installe ensuite depuis le navigateur. Aucun réseau n’est nécessaire pour AFFICHER le code — il en faut un à l’autre bateau pour la télécharger la première fois.'));

  const holder = el('div', 'qr-holder');
  body.append(holder);
  let canvas;
  try {
    canvas = renderQR(url, 320);
    holder.append(canvas);
  } catch (e) {
    console.error('[share]', e);
    holder.append(el('div', 'banner danger', 'Code impossible à générer sur cet appareil.'));
  }

  const urlLine = el('div', 'qr-url', url);
  body.append(urlLine);

  const acts = el('div', 'btn-row');
  acts.append(
    button('📤 Partager', 'btn-primary', async () => {
      const text = `Grim's Compagnon — navigation et pêche, secteur de Dieppe : ${url}`;
      try {
        if (navigator.share) return void (await navigator.share({ title: "Grim's Compagnon", text, url }));
      } catch {
        return; // partage annulé
      }
      copy(url);
    }),
    button('📋 Copier', '', () => copy(url)),
  );
  body.append(acts);

  const full = button('🔆 Plein écran pour être scanné', 'btn-lg', () => openFullscreen(url));
  full.style.marginTop = '8px';
  body.append(full);

  body.append(el('p', 'tiny',
    `Version ${APP_VERSION}. L’app est gratuite, sans compte et sans publicité ; elle fonctionne hors réseau une fois installée. `
    + 'Rien de ce qui est enregistré à bord — marques, prises, traces — ne quitte le téléphone.'));

  return openSheet('Partager l’app', body);
}

/* --------------------------------------------------------------------------
 * Plein écran
 * ------------------------------------------------------------------------ */
function openFullscreen(url) {
  const screen = el('div', 'qr-full');
  const inner = el('div', 'qr-full-inner');
  const side = Math.min(window.innerWidth - 48, window.innerHeight - 200, 520);
  try {
    inner.append(renderQR(url, Math.max(240, side)));
  } catch {
    inner.append(el('div', null, url));
  }
  inner.append(el('div', 'qr-full-title', "GRIM'S COMPAGNON"));
  inner.append(el('div', 'qr-full-sub', 'Navigation & pêche · secteur de Dieppe'));
  inner.append(el('div', 'qr-full-url', url));
  screen.append(inner);

  const close = el('button', 'qr-full-close', 'Fermer');
  close.type = 'button';
  close.addEventListener('click', () => screen.remove());
  screen.append(close);
  // Le mode nuit passe tout l'écran au rouge : ici on veut du blanc franc,
  // c'est le contraste qui décide si le code est lu ou non.
  screen.classList.add('no-night');
  document.body.append(screen);
  return screen;
}

/* --------------------------------------------------------------------------
 * Rendu
 * --------------------------------------------------------------------------
 * Modules arrondis, yeux de repérage dessinés à part, ancre au centre. Le
 * dessin ne doit jamais coûter de lisibilité : les coins arrondis restent dans
 * la cellule, la marge de silence fait les 4 modules réglementaires, et
 * l'ancre ne couvre que 15 % de la surface là où le niveau H en pardonne 30.
 * ------------------------------------------------------------------------ */
export function renderQR(text, cssSize = 320, opts = {}) {
  const qr = encode(text, { level: 'H' });
  const quiet = 4;
  const total = qr.size + quiet * 2;
  const dpr = Math.min(3, window.devicePixelRatio || 1);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Code QR vers ${text}`);

  const ctx = canvas.getContext('2d');
  const unit = canvas.width / total;
  const dark = '#0a1421';
  const accent = '#0e7490';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const isFinder = (x, y) => (x < 7 && y < 7)
    || (x >= qr.size - 7 && y < 7)
    || (x < 7 && y >= qr.size - 7);

  /* Modules de données. Les valeurs par défaut ne sont pas un goût, ce sont des
   * MESURES : à gap 0,06 et arrondi 0,34, un vrai lecteur ne décode plus le
   * code — les modules deviennent des points trop détachés et le binariseur les
   * perd. À 0,03 / 0,25 il reste arrondi à l'œil et se relit à tous les coups.
   * Toute retouche esthétique ici doit repasser par la relecture automatique. */
  const inset = opts.gap ?? 0.03;
  const r = unit * (opts.round ?? 0.25);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x] || isFinder(x, y)) continue;
      const px = (x + quiet) * unit;
      const py = (y + quiet) * unit;
      ctx.fillStyle = dark;
      roundRect(ctx, px + unit * inset, py + unit * inset, unit * (1 - inset * 2), unit * (1 - inset * 2), r);
      ctx.fill();
    }
  }

  // Yeux de repérage : dessinés d'un trait, pas module par module. C'est ce
  // que les lecteurs cherchent en premier, autant leur donner des bords nets.
  const eye = (cx, cy) => {
    const x = (cx + quiet) * unit;
    const y = (cy + quiet) * unit;
    ctx.fillStyle = dark;
    roundRect(ctx, x, y, unit * 7, unit * 7, unit * 1.9);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x + unit, y + unit, unit * 5, unit * 5, unit * 1.35);
    ctx.fill();
    ctx.fillStyle = accent;
    roundRect(ctx, x + unit * 2, y + unit * 2, unit * 3, unit * 3, unit * 0.85);
    ctx.fill();
  };
  eye(0, 0);
  eye(qr.size - 7, 0);
  eye(0, qr.size - 7);

  // Ancre centrale, sur pastille blanche.
  if (opts.logo === false) return canvas;
  const badge = unit * qr.size * 0.19;
  const cx = canvas.width / 2;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cx - badge / 2, cx - badge / 2, badge, badge, badge * 0.28);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.font = `${badge * 0.62}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚓', cx, cx + badge * 0.03);

  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

async function copy(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    toast('Lien copié', 'good');
  } catch {
    toast('Copie refusée par le navigateur');
  }
}

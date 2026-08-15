/* ==========================================================================
 * ui/fleet.js — la flotte : couche carte, fiches, réglage de partage
 * --------------------------------------------------------------------------
 * Un bateau de la flotte se dessine comme un bateau, pas comme une punaise :
 * une étrave orientée au cap, pour qu'on voie d'un coup d'œil s'il vient vers
 * soi ou s'il s'en va. C'est la seule chose qui rend la couche utile plutôt
 * que décorative.
 *
 * Trois états visuels, et un seul compte vraiment :
 *   normal    contour cyan, translucide
 *   ancien    plus de 5 minutes sans nouvelle : estompé, le cap n'est plus sûr
 *   DÉTRESSE  rouge plein, halo, toujours au-dessus des autres
 *
 * Le réglage de partage n'est pas un interrupteur perdu dans les préférences.
 * Il est sur la carte, sous le pouce, et dit à chaque instant ce que les
 * autres voient de toi. Une fonction qui expose la position doit pouvoir se
 * couper sans chercher.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as fmt from '../core/fmt.js';
import * as presence from '../core/presence.js';
import * as profile from '../core/profile.js';
import * as sync from '../core/sync.js';
import { state } from '../core/store.js';

const label = (list, id) => list.find((x) => x.id === id)?.name || null;

/** Nom affichable d'un bateau distant. Sans nom, on ne prétend pas en avoir. */
export function boatLabel(b) {
  return b.boat?.boatName || 'Bateau sans nom';
}

/* --------------------------------------------------------------------------
 * Couche carte
 * ------------------------------------------------------------------------ */

/**
 * @param {object} L      Leaflet
 * @param {object} group  couche de destination, vidée à chaque appel
 * @param {(b:object)=>void} onPick
 */
export function draw(L, group, onPick) {
  group.clearLayers();
  for (const b of presence.boats()) {
    const stale = b.ageMs > 5 * 60000;
    const alert = !!b.distress;
    const colour = alert ? '#fb5a72' : stale ? '#64809d' : '#22d3ee';

    // Étrave orientée : un triangle tourné au cap fond. Sans cap connu on
    // dessine un rond — mentir sur une direction serait pire que se taire.
    const hasCog = Number.isFinite(b.cogDeg);
    const icon = L.divIcon({
      className: 'fleet-icon',
      html: hasCog
        ? `<svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${b.cogDeg}deg)">
             <path d="M12 2 L19 21 L12 17 L5 21 Z" fill="${colour}" fill-opacity="${alert ? 0.9 : 0.35}"
                   stroke="${colour}" stroke-width="1.6" stroke-linejoin="round"/>
           </svg>`
        : `<svg viewBox="0 0 24 24" width="22" height="22">
             <circle cx="12" cy="12" r="7" fill="${colour}" fill-opacity="0.25"
                     stroke="${colour}" stroke-width="2"/>
           </svg>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const m = L.marker([b.lat, b.lon], { icon, zIndexOffset: alert ? 900 : 200 }).addTo(group);
    m.bindTooltip(alert ? `⚠️ ${boatLabel(b)}` : boatLabel(b), {
      className: 'spot-label',
      direction: 'top',
      offset: [0, -12],
      permanent: alert,
    });
    m.on('click', (e) => {
      L.DomEvent.stop(e);
      onPick(b);
    });
  }
}

/* --------------------------------------------------------------------------
 * Fiche d'un bateau
 * ------------------------------------------------------------------------ */
export function openBoat(b) {
  const body = el('div');

  if (b.distress) {
    body.append(el('div', 'banner danger',
      b.distress === 'mob'
        ? 'HOMME À LA MER déclaré à bord de ce bateau. Fais route et préviens le CROSS au 196.'
        : 'DÉTRESSE déclarée à bord de ce bateau. Fais route et préviens le CROSS au 196.'));
  }

  const head = el('div', 'card');
  head.append(el('h2', 'list-title', boatLabel(b)));
  const bits = [
    label(profile.HULL_TYPES, b.boat?.hull),
    b.boat?.lengthM ? `${String(b.boat.lengthM).replace('.', ',')} m` : null,
    label(profile.PROPULSIONS, b.boat?.propulsion),
  ].filter(Boolean);
  if (bits.length) head.append(el('div', 'list-sub', bits.join(' · ')));
  if (b.boat?.fishing?.length) {
    const r = el('div', 'row wrap');
    r.style.marginTop = '6px';
    for (const f of b.boat.fishing) {
      r.append(el('span', 'chip', label(profile.FISHING_TYPES, f) || f));
    }
    head.append(r);
  }
  body.append(head);

  const strip = el('div', 'strip');
  strip.append(
    pill(fmt.dist(b.distM), 'DISTANCE'),
    pill(fmt.heading(b.bearingDeg), 'RELÈVEMENT'),
    pill(Number.isFinite(b.sogKn) ? `${b.sogKn.toFixed(1)} nd` : '—', 'VITESSE'),
    pill(Number.isFinite(b.cogDeg) ? fmt.heading(b.cogDeg) : '—', 'CAP'),
  );
  const cond = el('div', 'card tight');
  const wrap = el('div', 'strip-wrap');
  wrap.append(strip);
  cond.append(wrap);
  cond.append(el('div', 'cond-note', b.ageMs < 60000
    ? 'Position de moins d’une minute.'
    : `Dernière position il y a ${Math.round(b.ageMs / 60000)} min — il a pu bouger depuis.`));
  body.append(cond);

  const go = button(`🧭 Naviguer vers ${boatLabel(b)}`, b.distress ? 'btn-danger btn-lg' : 'btn-primary btn-lg',
    async () => {
      const { startNav } = await import('./destination.js');
      startNav({ lat: b.lat, lon: b.lon, name: boatLabel(b), kind: 'boat' });
    });
  go.style.marginTop = '12px';
  body.append(go);
  body.append(el('p', 'tiny',
    'Un bateau bouge : le but est figé à sa position au moment où tu l’as touché. Rappelle-le à la VHF pour te faire préciser sa route.'));

  openSheet(b.distress ? '⚠️ Bateau en détresse' : 'Bateau', body);
}

function pill(v, l) {
  const p = el('div', 'pill');
  p.style.minWidth = '84px';
  p.append(el('div', 'pill-val', v), el('div', 'pill-lbl', l));
  return p;
}

/* --------------------------------------------------------------------------
 * Réglage du partage
 * ------------------------------------------------------------------------ */
export function openSettings() {
  const body = el('div');

  if (!sync.isLoggedIn()) {
    body.append(el('div', 'banner warn',
      'La flotte demande un compte : c’est lui qui identifie ton bateau auprès des autres.'));
  }

  body.append(el('p', 'muted',
    'Ce que les autres bateaux équipés de Grim’s voient de toi. Rien n’est partagé tant que tu ne l’as pas choisi, et ça se coupe d’un tap depuis la carte.'));

  const box = el('div', 'card flush');
  const rows = [];
  for (const lv of presence.LEVELS) {
    const row = el('button', 'list-item');
    row.type = 'button';
    const main = el('div', 'list-main');
    main.append(el('div', 'list-title', lv.name));
    main.append(el('div', 'list-sub', lv.desc));
    const mark = el('div', 'score-badge', '');
    mark.style.background = 'transparent';
    mark.style.minWidth = '34px';
    row.append(main, mark);
    row.addEventListener('click', async () => {
      await presence.setLevel(lv.id);
      paint();
      toast(lv.id === 'off' ? 'Tu es invisible' : `Partage : ${lv.short.toLowerCase()}`,
        lv.id === 'sea' ? 'warn' : 'good');
    });
    rows.push({ id: lv.id, row, mark });
    box.append(row);
  }
  body.append(box);

  const warn = el('div');
  body.append(warn);

  /* Ce que l'app fait sans le demander, écrit avant qu'on le découvre. */
  const always = el('div', 'card');
  const ah = el('div', 'card-head');
  ah.append(el('h3', null, 'CE QUI S’APPLIQUE TOUJOURS'));
  always.append(ah);
  for (const t of [
    'À quai — à moins de 250 m du port — rien n’est publié, quel que soit le réglage.',
    'Le partage s’éteint tout seul après 12 heures, pour le téléphone oublié dans un sac.',
    'En cas de MOB ou de SOS, ta position part avec le pavillon de détresse MÊME si le partage est éteint. C’est le seul cas où l’app passe outre ton réglage.',
    'Tu vois les autres même en Invisible : regarder ne coûte rien à personne.',
  ]) {
    always.append(el('div', 'list-sub', `• ${t}`));
  }
  body.append(always);

  function paint() {
    for (const r of rows) {
      const on = presence.level() === r.id;
      r.row.classList.toggle('on', on);
      r.mark.textContent = on ? '✓' : '';
      r.mark.style.color = on ? 'var(--cyan)' : 'transparent';
    }
    clear(warn);
    if (presence.level() === 'sea') {
      warn.append(el('div', 'banner warn',
        'En mer : un bateau immobile deux heures au même endroit, c’est une marque révélée. C’est le prix de la sécurité, et c’est ton choix.'));
    }
  }
  paint();

  openSheet('Partage de position', body);
}

/* --------------------------------------------------------------------------
 * Pastille d'état pour la carte
 * ------------------------------------------------------------------------ */
export function statusChip() {
  // Sans compte, la flotte n'existe pas : une pastille qui affiche « 0 bateau »
  // à quelqu'un qui n'a rien activé est un bouton mort de plus sur la carte.
  if (!sync.isLoggedIn()) return null;
  const n = presence.boats().length;
  const lv = presence.LEVELS.find((l) => l.id === presence.level());
  const alert = presence.distressNearby().length;
  const c = el('button', `chip chip-btn ${alert ? 'bad' : presence.isSharing() ? 'good' : ''}`);
  c.type = 'button';
  c.textContent = alert
    ? `⚠️ ${alert} détresse`
    : `⛵ ${n} · ${lv?.short || 'Invisible'}`;
  c.addEventListener('click', () => openSettings());
  return c;
}

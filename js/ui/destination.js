/* ==========================================================================
 * ui/destination.js — choisir un but de navigation
 * --------------------------------------------------------------------------
 * Quatre façons de désigner un point, parce qu'à bord elles arrivent toutes
 * les quatre et qu'aucune n'est plus légitime que les autres :
 *
 *   CHIFFRES   quelqu'un donne une position à la VHF ou par message. On la
 *              tape. Le clavier doit être NUMÉRIQUE — pas un champ texte où il
 *              faut basculer trois fois de pavé pour écrire 49°55.94'N — et la
 *              saisie doit se faire en degrés-minutes décimales, la seule
 *              forme qu'on lit à voix haute sans se tromper.
 *   MARQUES    le carnet personnel : ridins relevés au sondeur, épaves,
 *              points d'entrée de chenal.
 *   PRISES     là où ça a mordu. C'est le vrai carnet de pêche, et y retourner
 *              est la première chose qu'on veut faire à la sortie suivante.
 *   REPÈRES    le port, l'homme à la mer, le mouillage : les points qu'on ne
 *              cherche pas, on les veut tout de suite.
 *
 * Tout est trié par distance quand une position est connue : la liste répond à
 * « qu'est-ce qui est près de moi », qui est la question réellement posée.
 * ========================================================================== */

import { state } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as fmt from '../core/fmt.js';
import { distance, bearing, parseLatLon, ddmToDec, decToDDM } from '../core/geo.js';
import * as spots from '../fishing/spots.js';
import * as learning from '../fishing/learning.js';
import * as record from '../fishing/record.js';
import * as route from '../nav/route.js';

/**
 * Ouvre le sélecteur de destination.
 * @param {{ tab?:'coords'|'marks'|'catches'|'refs', onPick?:(dest)=>void }} [opts]
 *   onPick — si absent, on démarre directement la navigation.
 */
export function openDestinationPicker(opts = {}) {
  const onPick = opts.onPick || ((d) => startNav(d));
  const body = el('div');

  const seg = el('div', 'seg');
  const panel = el('div');
  panel.style.marginTop = '10px';

  const tabs = [
    ['coords', '⌨️ Chiffres'],
    ['marks', '📍 Marques'],
    ['catches', '🐟 Prises'],
    ['refs', '⚓ Repères'],
  ];
  const buttons = new Map();
  for (const [key, label] of tabs) {
    const b = el('button', '', label);
    b.type = 'button';
    b.addEventListener('click', () => show(key));
    seg.append(b);
    buttons.set(key, b);
  }

  function show(key) {
    for (const [k, b] of buttons) b.classList.toggle('on', k === key);
    clear(panel);
    if (key === 'coords') panel.append(coordsPane(onPick));
    else if (key === 'marks') panel.append(marksPane(onPick));
    else if (key === 'catches') panel.append(catchesPane(onPick));
    else panel.append(refsPane(onPick));
  }

  body.append(seg, panel);
  show(opts.tab || (state.fix ? 'marks' : 'coords'));
  return openSheet('Aller à…', body);
}

/** Démarre la navigation et bascule en pilotage. */
export function startNav(dest, opts) {
  const nav = route.start(dest, opts);
  if (!nav) return void toast('Position invalide', 'danger');
  closeSheet();
  navigator.vibrate?.([20, 40, 20]);
}

/* ==========================================================================
 * 1. Saisie de coordonnées
 * ========================================================================== */
function coordsPane(onPick) {
  const wrap = el('div');
  const here = state.fix ? decToDDM(state.fix.lat, 'lat') : { deg: 49, minutes: 55.9, hemi: 'N' };
  const hereLon = state.fix ? decToDDM(state.fix.lon, 'lon') : { deg: 1, minutes: 5.1, hemi: 'E' };

  const lat = ddmRow('Latitude', here, ['N', 'S'], 2);
  const lon = ddmRow('Longitude', hereLon, ['E', 'O'], 3);
  wrap.append(lat.node, lon.node);

  /* --- Nom du point ---------------------------------------------------- */
  const nameField = el('div', 'field');
  nameField.append(el('label', null, 'Nom (facultatif)'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Ex. Bouée d’atterrissage';
  nameField.append(nameInput);
  wrap.append(nameField);

  /* --- Aperçu vivant ---------------------------------------------------- */
  const preview = el('div', 'coord-preview');
  wrap.append(preview);

  const readPos = () => {
    const la = ddmToDec(lat.deg.value, lat.min.value, lat.hemi());
    const lo = ddmToDec(lon.deg.value, lon.min.value, lon.hemi());
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    if (Math.abs(la) < 0.0001 && Math.abs(lo) < 0.0001) return null;
    return { lat: la, lon: lo };
  };

  const go = button('🎯 Naviguer vers ce point', 'btn-primary btn-lg', () => {
    const p = readPos();
    if (!p) return void toast('Coordonnées incomplètes', 'danger');
    onPick({ ...p, name: nameInput.value.trim() || fmt.posDDM(p), kind: 'coord' });
  });

  const saveMark = button('📍 Enregistrer aussi comme repère', 'btn-sm', async () => {
    const p = readPos();
    if (!p) return void toast('Coordonnées incomplètes', 'danger');
    await spots.addSpot({
      name: nameInput.value.trim() || `Point ${fmt.hhmm(Date.now())}`,
      lat: p.lat,
      lon: p.lon,
      note: 'Saisi au clavier.',
    });
    toast('Repère enregistré', 'good');
  });
  saveMark.style.marginTop = '8px';

  const paint = () => {
    const p = readPos();
    clear(preview);
    if (!p) {
      preview.append(el('span', 'tiny', 'Entre une latitude et une longitude.'));
      go.disabled = true;
      return;
    }
    go.disabled = false;
    preview.append(el('div', 'tnum', fmt.posDDM(p)));
    if (state.fix) {
      const d = distance(state.fix, p);
      const b = bearing(state.fix, p);
      preview.append(el('div', 'tiny', `${fmt.dist(d)} au ${fmt.heading(b)} (${fmt.cardinal(b)}) depuis ta position`));
      if (d > 60000) {
        preview.append(el('div', 'chip warn', 'Plus de 32 milles — vérifie les chiffres'));
      }
    } else {
      preview.append(el('div', 'tiny', 'Pas de position GPS : distance et relèvement indisponibles.'));
    }
  };
  for (const inp of [lat.deg, lat.min, lon.deg, lon.min]) inp.addEventListener('input', paint);
  lat.onHemi = paint;
  lon.onHemi = paint;

  wrap.append(go, saveMark);

  /* --- Collage libre ----------------------------------------------------- *
   * Une position reçue par message n'est jamais au format qu'on attend. On
   * accepte tout, on remplit les cases, et on laisse l'utilisateur vérifier. */
  wrap.append(el('div', 'hr'));
  const pasteField = el('div', 'field');
  pasteField.append(el('label', null, 'Ou colle une position (tous formats)'));
  const paste = document.createElement('input');
  paste.type = 'text';
  paste.placeholder = "49°55.94'N 001°04.98'E";
  pasteField.append(paste);
  wrap.append(pasteField);

  const applyPaste = (txt) => {
    const p = parseLatLon(txt);
    if (!p) return void toast('Position illisible', 'danger');
    const a = decToDDM(p.lat, 'lat');
    const b = decToDDM(p.lon, 'lon');
    lat.deg.value = String(a.deg);
    lat.min.value = String(a.minutes);
    lat.setHemi(a.hemi);
    lon.deg.value = String(b.deg);
    lon.min.value = String(b.minutes);
    lon.setHemi(b.hemi);
    paint();
    toast('Position reconnue', 'good');
  };
  paste.addEventListener('change', () => applyPaste(paste.value));
  const pasteBtn = button('📋 Coller depuis le presse-papier', 'btn-sm', async () => {
    try {
      applyPaste(await navigator.clipboard.readText());
    } catch {
      toast('Presse-papier inaccessible — colle dans le champ');
    }
  });
  wrap.append(pasteBtn);

  paint();
  return wrap;
}

/**
 * Une ligne degrés / minutes décimales / hémisphère.
 * Les deux champs sont NUMÉRIQUES : `inputmode="decimal"` fait sortir le pavé
 * chiffré sur iPhone comme sur Android, et `enterkeyhint` évite le clavier qui
 * reste ouvert sur le dernier champ.
 */
function ddmRow(label, initial, hemis, degWidth) {
  const node = el('div', 'field');
  node.append(el('label', null, label));

  const row = el('div', 'ddm-row');
  const mk = (value, placeholder, cls) => {
    const i = document.createElement('input');
    i.type = 'text';
    i.inputMode = 'decimal';
    i.enterKeyHint = 'done';
    i.autocomplete = 'off';
    i.className = cls;
    i.value = String(value);
    i.placeholder = placeholder;
    i.addEventListener('focus', () => i.select());
    return i;
  };

  const deg = mk(initial.deg, degWidth === 3 ? '001' : '49', 'ddm-deg');
  const min = mk(initial.minutes, '00.00', 'ddm-min');

  const toggle = el('button', 'ddm-hemi');
  toggle.type = 'button';
  let hemi = initial.hemi === hemis[1] ? hemis[1] : hemis[0];
  const api = { node, deg, min, hemi: () => hemi, onHemi: null, setHemi: null };
  const paintHemi = () => (toggle.textContent = hemi);
  toggle.addEventListener('click', () => {
    hemi = hemi === hemis[0] ? hemis[1] : hemis[0];
    paintHemi();
    navigator.vibrate?.(6);
    api.onHemi?.();
  });
  api.setHemi = (h) => {
    hemi = hemis.includes(h) ? h : hemis[0];
    paintHemi();
  };
  paintHemi();

  row.append(deg, el('span', 'ddm-sym', '°'), min, el('span', 'ddm-sym', '′'), toggle);
  node.append(row);
  return api;
}

/* ==========================================================================
 * 2. Marques du carnet
 * ========================================================================== */
function marksPane(onPick) {
  const wrap = el('div');
  const from = state.fix || spots.getPort();
  const list = spots.all()
    .map((s) => ({ s, d: distance(from, s), b: bearing(from, s) }))
    .sort((a, b) => a.d - b.d);

  if (!list.length) {
    wrap.append(el('div', 'empty', 'Aucune marque enregistrée. Appui long sur la carte pour en créer une.'));
  }

  /* Trois natures de point, et il ne faut surtout pas les confondre : une
   * marque relevée au sondeur, une ÉPAVE relevée par un service
   * hydrographique, et un secteur type dessiné à la main. Le pictogramme et
   * l'étiquette le disent avant qu'on ait lu le nom. */
  const box = el('div', 'card flush');
  // Douze, pas trente : ce panneau se lit en mer, d'une main, pour choisir un
  // but qui est presque toujours l'un des plus proches. Trente lignes, c'est
  // huit hauteurs d'écran à faire défiler sur un bateau qui tape — mesuré.
  const VISIBLE = 12;
  for (const { s, d, b } of list.slice(0, VISIBLE)) box.append(spotRow(s, d, b, onPick));
  wrap.append(box);
  if (list.length > VISIBLE) {
    const more = button(`Voir les ${list.length - VISIBLE} autres points`, 'btn-sm btn-ghost', () => {
      const rest = el('div', 'card flush');
      for (const { s, d, b } of list) rest.append(spotRow(s, d, b, onPick));
      openSheet('Tous les points', rest);
    });
    more.style.margin = '8px 0';
    wrap.append(more);
  }
  wrap.append(el('p', 'tiny',
    'Les épaves viennent du SHOM et de l’UKHO via EMODnet : ce sont des positions hydrographiques, pas des marques de pêche — arrive dessus au sondeur. Les secteurs types, eux, sont dessinés à la main et à recaler.'));
  return wrap;
}

function spotRow(s, d, b, onPick) {
  const wreck = s.source === 'wreck';
  return pickRow({
    emoji: wreck ? '🛳️' : s.seed ? '🟣' : '📍',
    title: s.name,
    sub: `${fmt.dist(d)} au ${fmt.heading(b)}${s.note ? ` · ${s.note}` : ''}`,
    tag: wreck ? 'épave relevée' : s.seed ? 'secteur type' : null,
    onClick: () => onPick({ lat: s.lat, lon: s.lon, name: s.name, note: s.note, id: s.id, kind: 'spot' }),
  });
}

/* ==========================================================================
 * 3. Prises
 * ========================================================================== */
function catchesPane(onPick) {
  const wrap = el('div');
  const box = el('div', 'card flush');
  wrap.append(box);
  box.append(el('div', 'empty', 'Lecture du journal…'));

  learning.catches().then((all) => {
    const from = state.fix || spots.getPort();
    const list = all
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
      .sort((a, b) => b.t - a.t)
      .slice(0, 60);
    clear(box);
    if (!list.length) {
      box.append(el('div', 'empty', 'Aucune prise géolocalisée pour le moment.'));
      return;
    }
    for (const c of list) {
      const info = record.speciesInfo(c.speciesId, c.speciesName);
      const d = distance(from, c);
      const b = bearing(from, c);
      box.append(pickRow({
        emoji: info.emoji,
        title: `${info.name}${c.lengthCm ? ` ${c.lengthCm} cm` : ''}${(c.count || 1) > 1 ? ` ×${c.count}` : ''}`,
        sub: `${new Date(c.t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })} ${fmt.hhmm(c.t)} · ${fmt.dist(d)} au ${fmt.heading(b)}`,
        onClick: () => onPick({
          lat: c.lat,
          lon: c.lon,
          name: `${info.name} ${new Date(c.t).toLocaleDateString('fr-FR')}`,
          kind: 'catch',
        }),
      }));
    }
  });
  return wrap;
}

/* ==========================================================================
 * 4. Repères fixes
 * ========================================================================== */
function refsPane(onPick) {
  const wrap = el('div');
  const box = el('div', 'card flush');
  const from = state.fix;
  const port = spots.getPort();

  const entries = [
    { emoji: '🏠', title: `Retour ${port.name}`, sub: 'Port d’attache', p: port },
    state.mob ? { emoji: '🆘', title: 'Homme à la mer', sub: `Marqué à ${fmt.hhmmss(state.mob.t)}`, p: state.mob, urgent: true } : null,
    state.anchor?.armed ? { emoji: '⚓', title: 'Point de mouillage', sub: `Rayon ${state.anchor.radiusM} m`, p: state.anchor } : null,
    state.waypoint ? { emoji: '🏁', title: state.waypoint.name || 'Waypoint posé', sub: 'Dernier point posé sur la carte', p: state.waypoint } : null,
  ].filter(Boolean);

  for (const e of entries) {
    const d = from ? distance(from, e.p) : null;
    const b = from ? bearing(from, e.p) : null;
    box.append(pickRow({
      emoji: e.emoji,
      title: e.title,
      sub: d != null ? `${fmt.dist(d)} au ${fmt.heading(b)} · ${e.sub}` : e.sub,
      urgent: e.urgent,
      onClick: () => onPick({ lat: e.p.lat, lon: e.p.lon, name: e.title, kind: 'ref' }),
    }));
  }
  wrap.append(box);
  return wrap;
}

/* --------------------------------------------------------------------------
 * Ligne de liste sélectionnable
 * ------------------------------------------------------------------------ */
function pickRow({ emoji, title, sub, tag, urgent, onClick }) {
  const b = el('button', 'list-item');
  b.type = 'button';
  const badge = el('div', 'score-badge');
  badge.style.background = urgent ? 'rgba(251,90,114,.18)' : 'var(--bg-2)';
  badge.style.fontSize = '18px';
  badge.textContent = emoji;
  const main = el('div', 'list-main');
  const t = el('div', 'list-title', title);
  main.append(t);
  if (tag) {
    const g = el('span', 'tag tag-seed', tag);
    g.style.marginLeft = '6px';
    t.append(g);
  }
  main.append(el('div', 'list-sub', sub));
  b.append(badge, main, el('div', 'list-right', '›'));
  b.addEventListener('click', onClick);
  return b;
}

/* ==========================================================================
 * ui/dom.js — fabrique d'éléments, feuille modale, toasts, alarmes
 * --------------------------------------------------------------------------
 * Tout est construit par createElement / textContent. Aucun innerHTML avec des
 * données : pas de surface XSS, même si demain les libellés viennent d'un
 * import GPX ou d'un fichier de zone édité à la main.
 * ========================================================================== */

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** Sucre : el('div.card > ...') en une expression. */
export function h(tag, cls, ...children) {
  const n = el(tag, cls);
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function metric(value, unit, label, cls = '', sub = null) {
  const wrap = el('div', 'metric');
  const v = el('div', `metric-val ${cls}`);
  v.append(document.createTextNode(String(value)));
  if (unit) v.append(el('span', 'metric-unit', unit));
  wrap.append(v, el('div', 'metric-lbl', label));
  if (sub) wrap.append(el('div', 'metric-sub', sub));
  return wrap;
}

export function pill(value, label, cls = '') {
  const p = el('div', 'pill');
  p.append(el('div', `pill-val ${cls}`, value), el('div', 'pill-lbl', label));
  return p;
}

export function chip(text, cls = '') {
  return el('span', `chip ${cls}`, text);
}

export function card(title, ...children) {
  const c = el('div', 'card');
  if (title) {
    const head = el('div', 'card-head');
    head.append(el('h3', null, title));
    c.append(head);
  }
  for (const ch of children.flat()) if (ch) c.append(ch);
  return c;
}

/**
 * Carte repliable. Un écran de réglages qui empile neuf cartes ouvertes fait
 * dix-neuf hauteurs d'écran : on ne le parcourt pas, on s'y perd. `<details>`
 * natif plutôt qu'un accordéon maison — il apporte le clavier, le lecteur
 * d'écran et la recherche dans la page sans une ligne de JavaScript.
 */
export function collapsible(title, content, { open = false, hint = null } = {}) {
  const d = document.createElement('details');
  d.className = 'card fold';
  d.open = open;
  const sum = document.createElement('summary');
  sum.className = 'fold-head';
  sum.append(el('h3', null, title));
  if (hint) sum.append(el('span', 'fold-hint', hint));
  sum.append(el('span', 'fold-chevron', '⌄'));
  d.append(sum);
  const wrap = el('div', 'fold-body');
  wrap.append(content);
  d.append(wrap);
  return d;
}

export function button(label, cls = '', onClick) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/* --------------------------------------------------------------------------
 * Feuille modale
 * ------------------------------------------------------------------------ */
const backdrop = () => document.getElementById('sheet-backdrop');

/* --------------------------------------------------------------------------
 * Pile de feuilles
 * --------------------------------------------------------------------------
 * Ouvrir une fiche depuis une liste DÉTRUISAIT la liste : on ressortait de
 * l'écran entier, et il fallait rouvrir le catalogue, retaper sa recherche,
 * refaire défiler soixante espèces pour regarder la suivante. C'était le
 * défaut le plus coûteux de l'app — pas une gêne, un mur.
 *
 * Une feuille ouverte par-dessus une autre EMPILE désormais, avec un chevron
 * de retour et la position de défilement conservée. Les gestes suivent la
 * convention mobile : ‹ et Échap et le glissé vers le bas reviennent d'un
 * niveau, ✕ et le fond ferment tout.
 * ------------------------------------------------------------------------ */
const stack = [];

/**
 * @param {() => void} [onClose] Appelé quand CETTE feuille disparaît, quelle
 *   qu'en soit la voie — retour, fermeture, glissé. Une feuille qui rafraîchit
 *   en direct doit pouvoir arrêter sa boucle.
 */
export function openSheet(title, content, onClose = null) {
  const bd = backdrop();
  const body = document.getElementById('sheet-body');

  // Mémorise l'état de la feuille courante avant de la recouvrir.
  if (stack.length) {
    const top = stack[stack.length - 1];
    top.scrollTop = body.scrollTop;
    top.nodes = [...body.childNodes];
  }

  stack.push({ title, content, onClose, scrollTop: 0, nodes: null });
  paintSheet();
  bd.hidden = false;
  return { close: closeSheet, back: popSheet, body };
}

function paintSheet() {
  const top = stack[stack.length - 1];
  if (!top) return;
  document.getElementById('sheet-title').textContent = top.title;
  const body = clear(document.getElementById('sheet-body'));
  if (top.nodes) body.append(...top.nodes);
  else body.append(top.content);
  // Lire scrollHeight force le recalcul de mise en page. Sans ça, la position
  // restaurée est rabotée par la hauteur de la feuille PRÉCÉDENTE — on revenait
  // d'une fiche courte au tout début d'une liste de soixante espèces.
  void body.scrollHeight;
  body.scrollTop = top.scrollTop;
  const back = document.getElementById('sheet-back');
  if (back) back.hidden = stack.length < 2;
  document.getElementById('sheet').classList.toggle('has-back', stack.length > 1);
}

/** Revient d'un niveau. Ferme si on était au premier. */
export function popSheet() {
  if (stack.length <= 1) return closeSheet();
  const gone = stack.pop();
  runClose(gone);
  paintSheet();
  return undefined;
}

export function closeSheet() {
  backdrop().hidden = true;
  const gone = stack.splice(0, stack.length).reverse();
  for (const s of gone) runClose(s);
  const back = document.getElementById('sheet-back');
  if (back) back.hidden = true;
}

function runClose(entry) {
  try {
    entry?.onClose?.();
  } catch (e) {
    console.error('[sheet] fermeture', e);
  }
}

/** Profondeur courante — utile aux vues qui veulent savoir où elles sont. */
export const sheetDepth = () => stack.length;

export function initSheet() {
  const bd = backdrop();
  bd.addEventListener('click', (e) => {
    if (e.target === bd) closeSheet();
  });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.getElementById('sheet-back')?.addEventListener('click', () => {
    navigator.vibrate?.(6);
    popSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bd.hidden) popSheet();
  });

  /* Bouton « retour » du téléphone : sur Android il fermait l'app entière au
     lieu de refermer la feuille ouverte. On pousse une entrée d'historique
     par feuille pour qu'il fasse ce qu'il fait partout ailleurs. */
  window.addEventListener('popstate', () => {
    if (!bd.hidden) popSheet();
  });

  // Fermeture par glissé vers le bas — le geste attendu sur une feuille.
  const sheet = document.getElementById('sheet');
  let startY = null;
  sheet.addEventListener('touchstart', (e) => {
    if (document.getElementById('sheet-body').scrollTop > 0) return;
    startY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
    sheet.style.transform = '';
    startY = null;
    if (dy > 110) popSheet();
  });
}

/* --------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------ */
/**
 * @param {{label:string, onClick:Function}} [action] bouton d'action inline.
 *   Sert surtout à l'annulation : dès qu'un seul tap suffit à écrire dans le
 *   journal, il faut pouvoir revenir en arrière aussi vite.
 */
export function toast(text, kind = '', ms = 2600, action = null) {
  const host = document.getElementById('toast-host');
  const t = el('div', `toast ${kind}`);
  t.append(el('span', null, text));
  if (action) {
    const b = el('button', 'toast-action', action.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      t.remove();
      action.onClick();
    });
    t.append(b);
    t.style.pointerEvents = 'auto';
  }
  host.append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .25s';
    setTimeout(() => t.remove(), 260);
  }, ms);
  return t;
}

/* --------------------------------------------------------------------------
 * Bandeaux
 * ------------------------------------------------------------------------ */
const shownBanners = new Set();
const bannerById = new Map();

/* Les bandeaux sont en position fixe au-dessus du contenu et lui volent donc
 * de la hauteur pour de bon. Mesuré sur iPhone SE : deux bandeaux empilés —
 * « compas silencieux » et l'invitation à installer — occupaient 278 px sur
 * 568, laissant 147 px de contenu. Un quart d'écran utile.
 *
 * D'où deux règles :
 *   1. UN SEUL bandeau visible, le plus grave ; les autres attendent leur tour
 *      et se signalent par un compteur. Deux avertissements simultanés, ce
 *      n'est pas deux fois plus d'information, c'est zéro fois — on les chasse
 *      tous les deux sans les lire.
 *   2. Deux lignes maximum, le texte complet au tap. Un bandeau doit se lire
 *      d'un coup d'œil ; s'il faut le lire vraiment, il faut le demander. */
const RANK = { danger: 0, warn: 1, good: 2, info: 3 };
const queue = [];   // { node, rank, seq } — ordonné à l'affichage

function measureBanners() {
  const host = document.getElementById('banner-host');
  const h = host.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--banner-h', `${Math.round(h)}px`);
}

let bannerObserver = null;
let bannerSeq = 0;

function paintBanners() {
  const host = clear(document.getElementById('banner-host'));
  queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  const top = queue[0];
  if (top) {
    host.append(top.node);
    const badge = top.node.querySelector('.banner-more');
    if (badge) {
      badge.textContent = `+${queue.length - 1}`;
      badge.hidden = queue.length < 2;
    }
  }
  measureBanners();
}

function removeBanner(node) {
  const i = queue.findIndex((e) => e.node === node);
  if (i >= 0) queue.splice(i, 1);
  paintBanners();
}

export function banner(text, level = 'info', { id = null, dismissible = true } = {}) {
  if (id && shownBanners.has(id)) return null;
  if (id) shownBanners.add(id);
  const host = document.getElementById('banner-host');
  if (!bannerObserver) {
    bannerObserver = new ResizeObserver(measureBanners);
    bannerObserver.observe(host);
  }
  const b = el('div', `banner ${level} clamped`);
  const span = el('span', null, text);
  b.append(span);
  // Le texte tronqué se déplie au tap — sur le texte, pas sur les boutons
  // qu'on aura pu greffer à côté.
  span.addEventListener('click', () => {
    b.classList.toggle('clamped');
    measureBanners();
  });
  b.append(el('span', 'banner-more'));
  b.querySelector('.banner-more').hidden = true;
  if (dismissible) {
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.addEventListener('click', () => removeBanner(b));
    b.append(x);
  }
  if (id) bannerById.set(id, b);
  queue.push({ node: b, rank: RANK[level] ?? 3, seq: bannerSeq++ });
  paintBanners();
  return b;
}

/**
 * Retire un bandeau devenu faux. Un avertissement qui survit à sa cause coûte
 * plus cher qu'il ne rapporte : l'équipage cesse de lire les suivants.
 */
export function dismissBanner(id) {
  const b = bannerById.get(id);
  if (!b) return;
  bannerById.delete(id);
  shownBanners.delete(id);
  removeBanner(b);
}

export function clearBanners() {
  queue.length = 0;
  paintBanners();
}

/**
 * Bandeau posé DANS une vue (et non dans le bandeau fixe) : même discipline
 * des deux lignes, même dépliement au tap. Sert aux avertissements qui
 * expliquent un calcul dégradé — utiles, mais pas au prix d'un tiers d'écran.
 */
export function noteBanner(text, level = 'warn') {
  const b = el('div', `banner ${level} clamped`);
  b.append(el('span', null, text));
  b.querySelector('span').addEventListener('click', () => b.classList.toggle('clamped'));
  return b;
}

/* --------------------------------------------------------------------------
 * Alarme plein écran
 * --------------------------------------------------------------------------
 * Une alarme de mouillage ou un MOB ne peut pas être un toast. Elle prend
 * l'écran, elle vibre, elle sonne, et elle ne part que sur une action.
 * ------------------------------------------------------------------------ */
let alarmNode = null;
let alarmTimer = 0;
let audioCtx = null;

export function alarm(title, detail, onAck) {
  if (alarmNode) alarmNode.remove();
  alarmNode = el('div', 'alarm');
  alarmNode.append(el('h2', null, title), el('p', null, detail));
  const b = button('ACQUITTER', 'btn-lg', () => {
    stopAlarm();
    onAck?.();
  });
  b.style.maxWidth = '260px';
  alarmNode.append(b);
  document.body.append(alarmNode);

  const beat = () => {
    navigator.vibrate?.([300, 120, 300, 120, 600]);
    beep();
  };
  beat();
  alarmTimer = setInterval(beat, 2200);
  return alarmNode;
}

export function stopAlarm() {
  clearInterval(alarmTimer);
  alarmTimer = 0;
  alarmNode?.remove();
  alarmNode = null;
  navigator.vibrate?.(0);
}

/**
 * Bip synthétisé : pas de fichier audio à charger, donc rien à télécharger et
 * rien qui puisse manquer hors ligne.
 */
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + i * 0.3);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.3 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.3 + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.3);
      osc.stop(now + i * 0.3 + 0.2);
    }
  } catch { /* audio indisponible : la vibration suffit */ }
}

/** Réveille le contexte audio depuis un geste utilisateur (exigence iOS). */
export function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch { /* ignore */ }
}

/* --------------------------------------------------------------------------
 * Rampe de couleur des scores
 * --------------------------------------------------------------------------
 * Bleu profond → lime, continue. Le tableau se lit comme un gradient, pas
 * comme sept paliers arbitraires.
 * ------------------------------------------------------------------------ */
export function heatColor(score) {
  const t = Math.max(0, Math.min(100, score)) / 100;
  const hue = 205 - 125 * t;
  const sat = 20 + 55 * t;
  const light = 14 + 46 * t;
  return {
    background: `hsl(${hue} ${sat}% ${light}%)`,
    color: t > 0.62 ? 'hsl(200 30% 10%)' : 'hsl(200 20% 74%)',
  };
}

export function scoreBadge(score, extra = '') {
  const b = el('div', `score-badge ${extra}`, String(score));
  const c = heatColor(score);
  b.style.background = c.background;
  b.style.color = c.color;
  return b;
}

export function factorBars(breakdown) {
  const frag = document.createDocumentFragment();
  for (const f of breakdown || []) {
    const row = el('div', 'fbar');
    row.append(el('span', 'fbar-lbl', f.label));
    const track = el('div', 'fbar-track');
    const fill = el('div', 'fbar-fill');
    fill.style.width = `${Math.round(f.value * 100)}%`;
    fill.style.background = heatColor(f.value * 100).background;
    track.append(fill);
    row.append(track, el('span', 'fbar-w', `×${f.weight}`));
    frag.append(row);
  }
  return frag;
}

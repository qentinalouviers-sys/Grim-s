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

/**
 * @param {() => void} [onClose] Appelé à la fermeture, quelle qu'en soit la
 *   voie — bouton, glissé, Échap, clic sur le fond. Une feuille qui rafraîchit
 *   en direct doit pouvoir arrêter sa boucle, sinon elle tourne pour rien
 *   jusqu'à la fin de la sortie.
 */
export function openSheet(title, content, onClose = null) {
  const bd = backdrop();
  closeSheet(); // une feuille déjà ouverte doit d'abord rendre ses ressources
  document.getElementById('sheet-title').textContent = title;
  const body = clear(document.getElementById('sheet-body'));
  body.append(content);
  body.scrollTop = 0;
  sheetOnClose = onClose;
  bd.hidden = false;
  return { close: closeSheet, body };
}

let sheetOnClose = null;

export function closeSheet() {
  backdrop().hidden = true;
  const fn = sheetOnClose;
  sheetOnClose = null;
  try {
    fn?.();
  } catch (e) {
    console.error('[sheet] fermeture', e);
  }
}

export function initSheet() {
  const bd = backdrop();
  bd.addEventListener('click', (e) => {
    if (e.target === bd) closeSheet();
  });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bd.hidden) closeSheet();
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
    if (dy > 110) closeSheet();
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

/**
 * Les bandeaux sont en position fixe au-dessus du contenu : on répercute leur
 * hauteur réelle sur --banner-h, sinon un avertissement de trois lignes
 * recouvre la première jauge. Or c'est justement quand il y a un
 * avertissement qu'on a besoin de voir l'instrument.
 */
function measureBanners() {
  const host = document.getElementById('banner-host');
  const h = host.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--banner-h', `${Math.round(h)}px`);
}

let bannerObserver = null;

export function banner(text, level = 'info', { id = null, dismissible = true } = {}) {
  if (id && shownBanners.has(id)) return null;
  if (id) shownBanners.add(id);
  const host = document.getElementById('banner-host');
  if (!bannerObserver) {
    bannerObserver = new ResizeObserver(measureBanners);
    bannerObserver.observe(host);
  }
  const b = el('div', `banner ${level}`);
  b.append(el('span', null, text));
  if (dismissible) {
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.addEventListener('click', () => {
      b.remove();
      measureBanners();
    });
    b.append(x);
  }
  if (id) bannerById.set(id, b);
  host.append(b);
  measureBanners();
  return b;
}

/**
 * Retire un bandeau devenu faux. Un avertissement qui survit à sa cause coûte
 * plus cher qu'il ne rapporte : l'équipage cesse de lire les suivants.
 */
export function dismissBanner(id) {
  const b = bannerById.get(id);
  if (!b) return;
  b.remove();
  bannerById.delete(id);
  shownBanners.delete(id);
  measureBanners();
}

export function clearBanners() {
  clear(document.getElementById('banner-host'));
  measureBanners();
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

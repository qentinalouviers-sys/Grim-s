/* ==========================================================================
 * ui/widgets.js — instruments dessinés au canvas
 * --------------------------------------------------------------------------
 * Pourquoi canvas et pas SVG : ces cadrans se rafraîchissent à 10 Hz pendant
 * six heures. Muter des attributs SVG à ce rythme fait travailler le moteur
 * de style à chaque frame ; un canvas redessine dans un contexte isolé, sans
 * recalcul de layout. Sur un téléphone qui doit aussi tenir le GPS allumé,
 * l'écart de consommation est net.
 *
 * Tous les widgets suivent le même contrat : new Widget(parent, opts) puis
 * .set(...) et .destroy(). Le redimensionnement est géré par ResizeObserver,
 * le devicePixelRatio est pris en compte (sinon tout est flou sur écran Retina).
 * ========================================================================== */

import { norm360, angleDiff } from '../core/geo.js';

const DPR = () => Math.min(3, window.devicePixelRatio || 1);
const TAU = Math.PI * 2;

class Canvas {
  /**
   * Le constructeur de base NE DESSINE PAS. `super(...)` s'exécute avant que
   * la sous-classe ait posé ses options : dessiner ici ferait planter draw()
   * sur des champs pas encore initialisés. Chaque sous-classe appelle
   * `this.resize()` à la fin de son propre constructeur.
   */
  constructor(parent, height) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = `${height}px`;
    this.h = height;
    this.ready = false;
    parent.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => this.ready && this.resize());
    this.ro.observe(parent);
  }
  resize() {
    this.ready = true;
    const w = this.canvas.clientWidth || 300;
    const dpr = DPR();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.draw?.();
  }
  clearAll() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}

/* ==========================================================================
 * Jauge circulaire LED
 * ========================================================================== */
export class Gauge extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.size || 128);
    this.opts = {
      max: 12,
      color: '#22d3ee',
      label: '',
      unit: 'nd',
      decimals: 1,
      ticks: 6,
      ...opts,
    };
    this.value = 0;
    this.display = 0;
    this.canvas.style.height = `${this.opts.size || 128}px`;
    this.canvas.style.width = `${this.opts.size || 128}px`;
    this.canvas.style.margin = '0 auto';
    this.resize();
  }

  resize() {
    const size = this.opts?.size || 128;
    const dpr = DPR();
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = size;
    this.h = size;
    this.draw?.();
  }

  set(value, subtitle) {
    this.value = Number.isFinite(value) ? value : null;
    this.subtitle = subtitle;

    // Échelle adaptative. Un cadran calé sur 12 nœuds convient à un bateau de
    // pêche, et affiche une aiguille collée en butée dès que le téléphone
    // voyage autrement — en voiture sur la route du port, par exemple. Le
    // chiffre reste juste, mais le cadran ne veut plus rien dire. On monte
    // d'un cran, jamais on ne redescend pendant la session : une échelle qui
    // respire à chaque accélération est illisible.
    if (this.value != null && this.opts.autoRange !== false) {
      const steps = [this.opts.max, 30, 60, 120];
      const need = steps.find((s) => this.value <= s * 0.98);
      if (need && need > this.opts.max) this.opts.max = need;
    }
    this.animate();
  }

  animate() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      const target = this.value ?? 0;
      this.display += (target - this.display) * 0.22;
      this.draw();
      if (Math.abs(target - this.display) > 0.01) this.raf = requestAnimationFrame(step);
      else {
        this.display = target;
        this.draw();
      }
    };
    step();
  }

  draw() {
    const { ctx, w, h } = this;
    const { max, color, unit, decimals, ticks } = this.opts;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 9;
    // Arc de 270°, ouvert vers le bas — la convention des instruments de bord.
    const A0 = Math.PI * 0.75;
    const A1 = Math.PI * 2.25;

    this.clearAll();

    ctx.lineCap = 'round';

    // Piste
    ctx.beginPath();
    ctx.arc(cx, cy, r, A0, A1);
    ctx.strokeStyle = 'rgba(28,47,71,.9)';
    ctx.lineWidth = 7;
    ctx.stroke();

    // Graduations
    ctx.strokeStyle = 'rgba(100,128,157,.55)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= ticks; i++) {
      const a = A0 + ((A1 - A0) * i) / ticks;
      const inner = r - 11;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * (inner - 4), cy + Math.sin(a) * (inner - 4));
      ctx.stroke();
    }

    // Valeur
    const frac = Math.max(0, Math.min(1, this.display / max));
    if (frac > 0.002) {
      const a = A0 + (A1 - A0) * frac;
      ctx.beginPath();
      ctx.arc(cx, cy, r, A0, a);
      ctx.strokeStyle = color;
      ctx.lineWidth = 7;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Curseur
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 4.2, 0, TAU);
      ctx.fillStyle = '#e8f1fa';
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Chiffre
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8f1fa';
    const txt = this.value == null ? '—' : this.display.toFixed(decimals);
    ctx.font = `700 ${Math.round(r * 0.62)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(txt, cx, cy - 4);

    ctx.fillStyle = '#64809d';
    ctx.font = `700 ${Math.round(r * 0.2)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(unit, cx, cy + r * 0.42);

    if (this.subtitle) {
      ctx.fillStyle = '#9fb4cc';
      ctx.font = `600 ${Math.round(r * 0.19)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillText(this.subtitle, cx, cy + r * 0.68);
    }
  }
}

/* ==========================================================================
 * Compas demi-cercle
 * --------------------------------------------------------------------------
 * Le cadran tourne, la ligne de foi est fixe — comme un compas de route réel.
 * L'inverse (aiguille qui tourne sur cadran fixe) oblige à une conversion
 * mentale à chaque coup d'œil ; en mer on ne fait pas de conversion mentale.
 * Le centre de rotation est SOUS la zone visible : on ne voit que l'arc
 * supérieur, soit ±90° autour du cap, ce qui est exactement le champ utile.
 * ========================================================================== */
/** Constante de temps du cadran, en ms. Assez pour tuer le tremblement du
 *  magnétomètre, assez court pour qu'un virage ne se lise pas en différé. */
const TAU_DIAL = 60;

export class Compass extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 132);
    this.heading = 0;
    this.display = 0;
    this.marks = []; // { deg, color, label }
    this.quality = 'good';
    this.raf = 0;
    this.last = 0;
    // Liaison explicite plutôt qu'un champ de classe fléché : les champs de
    // classe n'existent qu'à partir de Safari 14.1, et le téléphone qu'on
    // laisse à demeure dans le bateau est rarement le plus récent.
    this.step = this.step.bind(this);
    this.resize();
  }

  /**
   * @param {number} heading cap vrai
   * @param {{deg:number,color:string,label:string}[]} marks relèvements à porter
   */
  set(heading, marks = [], quality = 'good') {
    if (!Number.isFinite(heading)) return;
    this.heading = norm360(heading);
    this.marks = marks;
    this.quality = quality;
    // On ne dessine PAS ici. Le capteur émet jusqu'à 60 fois par seconde et
    // parfois davantage : dessiner dans le fil de l'événement, c'est peindre
    // des images que l'écran ne montrera jamais. On se contente d'armer la
    // boucle d'animation, qui elle est calée sur le rafraîchissement réel.
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.step);
    }
  }

  /**
   * Suivi du cap à constante de temps, pas à coefficient par frame.
   *
   * Un lissage « display += écart × 0,25 à chaque frame » a l'air correct à
   * 60 im/s et devient un piège dès que la machine peine : à 20 im/s le même
   * coefficient triple le temps de rattrapage, si bien que l'aiguille traîne
   * exactement au moment où l'appareil est le plus chargé. En passant par
   * k = 1 − exp(−dt/τ), le temps de réponse est fixé en millisecondes et ne
   * dépend plus de la cadence d'affichage.
   */
  step(now) {
    this.raf = 0;
    const dt = Math.min(120, Math.max(1, now - this.last));
    this.last = now;

    // Écart au plus court chemin : sans ça, passer de 359° à 1° ferait faire
    // un tour complet au cadran.
    const d = angleDiff(this.heading, this.display);
    this.display = Math.abs(d) < 0.2
      ? this.heading
      : norm360(this.display + d * (1 - Math.exp(-dt / TAU_DIAL)));

    this.draw();
    if (Math.abs(angleDiff(this.heading, this.display)) > 0.2) {
      this.raf = requestAnimationFrame(this.step);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    super.destroy();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();

    const cx = w / 2;
    const R = Math.max(150, w * 0.62);
    // Centre sous la zone visible : on ne voit que la calotte supérieure, soit
    // ±62° autour du cap — exactement le champ utile. Le sommet de l'arc est
    // calé à 10 px du haut pour occuper toute la hauteur allouée.
    const cy = R + 6;
    const font = getComputedStyle(document.body).fontFamily;

    // Arc de fond
    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.PI * 1.18, Math.PI * 1.82);
    ctx.strokeStyle = 'rgba(28,47,71,.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // ±55° : au-delà, les chiffres du cadran sortent par le bas du canvas.
    const visible = 55;
    const toX = (deg) => {
      const rel = angleDiff(deg, this.display);
      if (Math.abs(rel) > visible) return null;
      const a = -Math.PI / 2 + (rel * Math.PI) / 180;
      return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, rel };
    };

    // Graduations tous les 5°, chiffrées tous les 30°
    for (let d = 0; d < 360; d += 5) {
      const p = toX(d);
      if (!p) continue;
      const major = d % 30 === 0;
      const cardinal = d % 90 === 0;
      const len = cardinal ? 15 : major ? 11 : 6;
      const fade = 1 - Math.abs(p.rel) / visible;

      ctx.globalAlpha = 0.25 + 0.75 * fade;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(cx + (p.x - cx) * ((R - len) / R), cy + (p.y - cy) * ((R - len) / R));
      ctx.strokeStyle = cardinal ? '#22d3ee' : major ? '#9fb4cc' : '#3c5a7d';
      ctx.lineWidth = cardinal ? 2.4 : major ? 1.8 : 1;
      ctx.stroke();

      if (major) {
        const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' }[d] ?? String(d);
        ctx.save();
        ctx.translate(cx + (p.x - cx) * ((R - len - 13) / R), cy + (p.y - cy) * ((R - len - 13) / R));
        ctx.rotate((p.rel * Math.PI) / 180);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = cardinal ? '#22d3ee' : '#9fb4cc';
        ctx.font = `${cardinal ? 800 : 650} ${cardinal ? 15 : 12}px ${font}`;
        ctx.fillText(lbl, 0, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // Relèvements portés (waypoint, MOB, axe de courant…)
    for (const m of this.marks) {
      const p = toX(m.deg);
      if (!p) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(cx + (p.x - cx) * ((R - 22) / R), cy + (p.y - cy) * ((R - 22) / R));
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 3;
      ctx.shadowColor = m.color;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (m.label) {
        ctx.save();
        ctx.translate(cx + (p.x - cx) * ((R - 34) / R), cy + (p.y - cy) * ((R - 34) / R));
        ctx.rotate((p.rel * Math.PI) / 180);
        ctx.textAlign = 'center';
        ctx.fillStyle = m.color;
        ctx.font = `750 10px ${font}`;
        ctx.fillText(m.label, 0, 0);
        ctx.restore();
      }
    }

    // Ligne de foi
    const bad = this.quality === 'bad' || this.quality === 'stale';
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 9);
    ctx.lineTo(cx, cy - R + 26);
    ctx.strokeStyle = bad ? '#fb5a72' : '#fb5a72';
    ctx.lineWidth = 2.6;
    ctx.shadowColor = '#fb5a72';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.moveTo(cx - 7, cy - R - 9);
    ctx.lineTo(cx + 7, cy - R - 9);
    ctx.lineTo(cx, cy - R + 2);
    ctx.closePath();
    ctx.fillStyle = '#fb5a72';
    ctx.fill();
  }
}

/* ==========================================================================
 * Indicateur d'écart de route (CDI)
 * --------------------------------------------------------------------------
 * L'instrument que tout GPS de passerelle possède et qu'aucune app grand
 * public n'affiche : où est la ROUTE par rapport au bateau. Pas le relèvement
 * du but — l'écart latéral à la ligne qu'on s'est fixée.
 *
 * Convention respectée à la lettre : l'aiguille montre où est la route, donc
 * on barre VERS l'aiguille. C'est l'inverse de l'intuition « je suis à droite
 * donc je vais à gauche », et c'est justement pour ça qu'il faut suivre la
 * convention des instruments de bord : à trois heures du matin, on applique un
 * réflexe, on ne fait pas une conversion mentale.
 *
 * L'échelle est adaptative — ±30 m près du but, ±300 m en route — sinon
 * l'aiguille reste collée en butée pendant toute la traversée puis devient
 * inutilisable au moment de l'atterrissage.
 * ========================================================================== */
export class CDI extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 56);
    this.xte = 0;
    this.scale = 100;
    this.resize();
  }

  /** @param {number} xteM écart latéral en mètres (positif = bateau à droite) */
  set(xteM, scaleM = null) {
    this.xte = Number.isFinite(xteM) ? xteM : null;
    if (scaleM) this.scale = scaleM;
    else {
      const need = Math.max(30, Math.abs(this.xte || 0) * 1.6);
      const steps = [30, 60, 100, 200, 300, 600, 1000];
      this.scale = steps.find((s) => need <= s) || 1852;
    }
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();
    const font = getComputedStyle(document.body).fontFamily;
    const cx = w / 2;
    const mid = h / 2 - 3;
    const half = w / 2 - 16;

    // Piste graduée
    ctx.strokeStyle = 'rgba(28,47,71,.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - half, mid);
    ctx.lineTo(cx + half, mid);
    ctx.stroke();

    for (let i = -4; i <= 4; i++) {
      const x = cx + (i / 4) * half;
      const major = i === 0;
      ctx.beginPath();
      ctx.moveTo(x, mid - (major ? 12 : 6));
      ctx.lineTo(x, mid + (major ? 12 : 6));
      ctx.strokeStyle = major ? 'rgba(163,230,53,.85)' : 'rgba(100,128,157,.5)';
      ctx.lineWidth = major ? 2.4 : 1.2;
      ctx.stroke();
    }

    // Aiguille : position de la ROUTE vue du bateau.
    if (this.xte != null) {
      const clamped = Math.max(-1, Math.min(1, -this.xte / this.scale));
      const x = cx + clamped * half;
      const off = Math.abs(this.xte);
      const color = off < 15 ? '#a3e635' : off < 60 ? '#fbbf24' : '#fb5a72';
      ctx.beginPath();
      ctx.moveTo(x, mid - 15);
      ctx.lineTo(x, mid + 15);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.4;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.moveTo(x - 6, mid - 15);
      ctx.lineTo(x + 6, mid - 15);
      ctx.lineTo(x, mid - 6);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    ctx.font = `700 9px ${font}`;
    ctx.fillStyle = '#64809d';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(`${this.scale} m`, 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(`${this.scale} m`, w - 2, h - 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a3e635';
    ctx.fillText('ROUTE', cx, h - 2);
  }
}

/* ==========================================================================
 * Courbe de marée
 * ========================================================================== */
export class TideChart extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 96);
    this.data = null;
    this.resize();
  }

  /**
   * @param {{series:{t,heightM}[], extrema:object[], now:number,
   *          windows?:{startT,endT,color}[]}} d
   */
  set(d) {
    this.data = d;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();
    const d = this.data;
    if (!d?.series?.length) return;

    const font = getComputedStyle(document.body).fontFamily;
    const padB = 16;
    const padT = 14;
    const t0 = d.series[0].t;
    const t1 = d.series[d.series.length - 1].t;
    const hs = d.series.map((p) => p.heightM);
    const hMin = Math.min(...hs) - 0.25;
    const hMax = Math.max(...hs) + 0.25;

    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    const Y = (m) => padT + (1 - (m - hMin) / (hMax - hMin)) * (h - padT - padB);

    // Fenêtres de pêche en fond
    for (const win of d.windows || []) {
      ctx.fillStyle = win.color || 'rgba(163,230,53,.12)';
      ctx.fillRect(X(win.startT), 0, Math.max(2, X(win.endT) - X(win.startT)), h - padB);
    }

    // Aire sous la courbe
    ctx.beginPath();
    ctx.moveTo(X(t0), h - padB);
    for (const p of d.series) ctx.lineTo(X(p.t), Y(p.heightM));
    ctx.lineTo(X(t1), h - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, 'rgba(34,211,238,.30)');
    grad.addColorStop(1, 'rgba(34,211,238,.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Courbe
    ctx.beginPath();
    d.series.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.heightM)) : ctx.moveTo(X(p.t), Y(p.heightM))));
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Repères horaires
    ctx.strokeStyle = 'rgba(28,47,71,.7)';
    ctx.fillStyle = '#64809d';
    ctx.font = `600 9px ${font}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    const startHour = new Date(t0);
    startHour.setMinutes(0, 0, 0);
    for (let t = startHour.valueOf(); t <= t1; t += 3 * 3600000) {
      if (t < t0) continue;
      const x = X(t);
      ctx.beginPath();
      ctx.moveTo(x, h - padB);
      ctx.lineTo(x, h - padB + 3);
      ctx.stroke();
      ctx.fillText(`${String(new Date(t).getHours()).padStart(2, '0')}h`, x, h - 4);
    }

    // PM / BM
    ctx.font = `700 9.5px ${font}`;
    for (const e of d.extrema || []) {
      if (e.t < t0 || e.t > t1) continue;
      const x = X(e.t);
      const y = Y(e.heightM);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, TAU);
      ctx.fillStyle = e.kind === 'HW' ? '#a3e635' : '#fb923c';
      ctx.fill();
      ctx.fillStyle = '#9fb4cc';
      ctx.textAlign = x > w - 40 ? 'right' : x < 40 ? 'left' : 'center';
      const label = `${e.kind === 'HW' ? 'PM' : 'BM'} ${String(new Date(e.t).getHours()).padStart(2, '0')}:${String(new Date(e.t).getMinutes()).padStart(2, '0')}`;
      ctx.fillText(label, x, e.kind === 'HW' ? y - 7 : y + 13);
    }

    // Instant présent
    if (d.now >= t0 && d.now <= t1) {
      const x = X(d.now);
      ctx.beginPath();
      ctx.moveTo(x, padT - 8);
      ctx.lineTo(x, h - padB);
      ctx.strokeStyle = '#e8f1fa';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      const hNow = d.series.reduce((a, b) => (Math.abs(b.t - d.now) < Math.abs(a.t - d.now) ? b : a));
      ctx.beginPath();
      ctx.arc(x, Y(hNow.heightM), 4.5, 0, TAU);
      ctx.fillStyle = '#e8f1fa';
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

/* ==========================================================================
 * Profil de courant sur 24 h
 * --------------------------------------------------------------------------
 * Signé : le flot au-dessus de l'axe, le jusant en dessous. On lit d'un coup
 * d'œil où sont les étales et de quel côté ça pousse — ce qu'une courbe de
 * hauteur ne dit pas directement.
 * ========================================================================== */
export class StreamProfile extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 74);
    this.data = null;
    this.resize();
  }

  set(profile, now) {
    this.data = { profile, now };
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();
    if (!this.data?.profile?.length) return;
    const { profile, now } = this.data;
    const font = getComputedStyle(document.body).fontFamily;

    const t0 = profile[0].t;
    const t1 = profile[profile.length - 1].t;
    const max = Math.max(0.6, ...profile.map((p) => p.spd));
    const mid = h / 2 - 4;
    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    const Y = (p) => mid - (p.sense === 'ebb' ? -1 : 1) * (p.spd / max) * (h / 2 - 12);

    // Axe
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.strokeStyle = 'rgba(28,47,71,.9)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Aire
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (const p of profile) ctx.lineTo(X(p.t), Y(p));
    ctx.lineTo(w, mid);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(34,211,238,.35)');
    g.addColorStop(0.5, 'rgba(34,211,238,.05)');
    g.addColorStop(0.5, 'rgba(251,146,60,.05)');
    g.addColorStop(1, 'rgba(251,146,60,.35)');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    profile.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p)) : ctx.moveTo(X(p.t), Y(p))));
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Légende
    ctx.font = `700 9px ${font}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#22d3ee';
    ctx.fillText('FLOT', 3, 11);
    ctx.fillStyle = '#fb923c';
    ctx.fillText('JUSANT', 3, h - 4);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#64809d';
    ctx.fillText(`max ${max.toFixed(1)} nd`, w - 3, 11);

    if (now >= t0 && now <= t1) {
      const x = X(now);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.strokeStyle = 'rgba(232,241,250,.7)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}


const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

/**
 * Glyphe de marque : fût à bandes, voyant AISM, point lumineux.
 * Le voyant est ce qui identifie une cardinale de jour ; le dessiner
 * approximativement serait pire que ne pas le dessiner.
 */
function drawMarkGlyph(ctx, x, baseY, size, it) {
  const wBody = size * 0.42;
  const hBody = size * 0.8;
  const colours = it.colours?.length ? it.colours : ['#94a3b8'];

  // Fût : une bande par couleur, du haut vers le bas.
  const bandH = hBody / colours.length;
  colours.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(x - wBody / 2, baseY - hBody + i * bandH, wBody, bandH + 0.5);
  });
  // Contour clair : une bouée à bande noire — les cardinales le sont toutes —
  // disparaîtrait purement et simplement sur un fond de nuit.
  ctx.strokeStyle = 'rgba(232,241,250,.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - wBody / 2, baseY - hBody, wBody, hBody);

  // Voyant
  const ty = baseY - hBody - 2;
  const s = size * 0.2;
  ctx.fillStyle = it.topmarkColour || '#0f172a';
  ctx.strokeStyle = 'rgba(232,241,250,.55)';
  const cone = (cyTop, up) => {
    ctx.beginPath();
    if (up) {
      ctx.moveTo(x, cyTop - s);
      ctx.lineTo(x - s * 0.8, cyTop);
      ctx.lineTo(x + s * 0.8, cyTop);
    } else {
      ctx.moveTo(x, cyTop);
      ctx.lineTo(x - s * 0.8, cyTop - s);
      ctx.lineTo(x + s * 0.8, cyTop - s);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  const ball = (cy) => {
    ctx.beginPath();
    ctx.arc(x, cy, s * 0.62, 0, TAU);
    ctx.fill();
    ctx.stroke();
  };

  switch (it.topmark) {
    case 'north':   cone(ty, true); cone(ty - s - 1, true); break;
    case 'south':   cone(ty, false); cone(ty - s - 1, false); break;
    case 'east':    cone(ty, false); cone(ty - s - 1, true); break;   // base à base
    case 'west':    cone(ty, true); cone(ty - s - 1, false); break;   // pointe à pointe
    case 'sphere':  ball(ty - s * 0.6); break;
    case '2 spheres': ball(ty - s * 0.6); ball(ty - s * 2); break;
    case 'cylinder': ctx.fillRect(x - s * 0.6, ty - s * 1.4, s * 1.2, s * 1.4); ctx.strokeRect(x - s * 0.6, ty - s * 1.4, s * 1.2, s * 1.4); break;
    case 'cone, point up': cone(ty, true); break;
    case 'x-shape': {
      ctx.beginPath();
      ctx.moveTo(x - s * 0.7, ty - s * 1.4); ctx.lineTo(x + s * 0.7, ty);
      ctx.moveTo(x + s * 0.7, ty - s * 1.4); ctx.lineTo(x - s * 0.7, ty);
      ctx.strokeStyle = it.topmarkColour || '#facc15';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      break;
    }
    default: break;
  }

  // Feu
  if (it.lit) {
    ctx.beginPath();
    ctx.arc(x, baseY - hBody - s * 2.6, 3.4, 0, TAU);
    ctx.fillStyle = it.lit;
    ctx.shadowColor = it.lit;
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

/* ==========================================================================
 * Rose de courant — flèche animée
 * ========================================================================== */
export class CurrentRose extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 118);
    this.vec = null;
    this.resize();
  }

  /** @param {{dir,spd,sense}} vec @param {{dir,spd}} [wind] */
  set(vec, wind, heading) {
    this.vec = vec;
    this.wind = wind;
    this.headingDeg = heading;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();
    if (!this.vec) return;
    const font = getComputedStyle(document.body).fontFamily;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 12;

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.strokeStyle = 'rgba(28,47,71,.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#3c5a7d';
    ctx.font = `700 9px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    [['N', 0], ['E', 90], ['S', 180], ['O', 270]].forEach(([l, d]) => {
      const a = ((d - 90) * Math.PI) / 180;
      ctx.fillText(l, cx + Math.cos(a) * (R + 6), cy + Math.sin(a) * (R + 6));
    });

    // Cap du bateau, en repère
    if (Number.isFinite(this.headingDeg)) {
      const a = ((this.headingDeg - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R * 0.92, cy + Math.sin(a) * R * 0.92);
      ctx.strokeStyle = 'rgba(232,241,250,.25)';
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Vent (trait fin, direction VERS laquelle il pousse)
    if (this.wind && Number.isFinite(this.wind.dir)) {
      const a = ((this.wind.dir + 180 - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * R * 0.6, cy - Math.sin(a) * R * 0.6);
      ctx.lineTo(cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6);
      ctx.strokeStyle = 'rgba(167,139,250,.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Flèche de courant
    const color = this.vec.sense === 'ebb' ? '#fb923c' : this.vec.sense === 'slack' ? '#64809d' : '#22d3ee';
    const a = ((this.vec.dir - 90) * Math.PI) / 180;
    const len = R * 0.86;
    const tipX = cx + Math.cos(a) * len;
    const tipY = cy + Math.sin(a) * len;

    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * len * 0.5, cy - Math.sin(a) * len * 0.5);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + Math.cos(a + 2.6) * 12, tipY + Math.sin(a + 2.6) * 12);
    ctx.lineTo(tipX + Math.cos(a - 2.6) * 12, tipY + Math.sin(a - 2.6) * 12);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#e8f1fa';
    ctx.font = `750 17px ${font}`;
    ctx.fillText(this.vec.spd.toFixed(1), cx, cy - 6);
    ctx.fillStyle = '#64809d';
    ctx.font = `700 9px ${font}`;
    ctx.fillText('NŒUDS', cx, cy + 9);
  }
}

/* ==========================================================================
 * Le courant, en vagues
 * --------------------------------------------------------------------------
 * D'OÙ VIENT L'EAU. C'est la question qu'on se pose en dérivant, et aucun
 * chiffre n'y répond vite : « courant 118° » demande de se représenter une
 * rose, de la tourner mentalement sur son cap, et de conclure. Trois secondes
 * de regard baissé pour une information qu'on peut voir.
 *
 * Alors on la montre. Le bateau est fixe, étrave en haut — comme sur le
 * compas, où c'est la rose qui tourne. Les vagues traversent l'écran dans le
 * sens où l'eau porte VRAIMENT, et leur vitesse suit celle du courant : à
 * l'étale elles s'arrêtent, à trois nœuds elles filent. On lit d'où ça vient
 * sans lire un seul chiffre.
 *
 * ── LES DEUX CONVENTIONS, ÉCRITES TOUTES LES DEUX ─────────────────────────
 * Le vent se donne d'où il VIENT, le courant vers où il PORTE. Les confondre
 * inverse l'information de cent-quatre-vingts degrés. Le titre annonce donc
 * d'où vient l'eau — ce qu'on a demandé, et ce qu'on ressent à bord — et la
 * ligne du dessous annonce vers où elle porte, avec son cap. Les deux, jamais
 * l'un à la place de l'autre.
 *
 * ── POURQUOI L'ANIMATION S'ARRÊTE ─────────────────────────────────────────
 * Une boucle d'animation qui tourne dans un onglet caché vide une batterie
 * sans rien montrer. Celle-ci se met en pause dès que la page passe en
 * arrière-plan et reprend au retour.
 * ========================================================================== */
export class CurrentFlow extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 96);
    this.vec = null;
    this.headingDeg = null;
    this.phase = 0;
    this.last = 0;
    this.raf = 0;
    this.onVis = () => (document.hidden ? this.pause() : this.play());
    document.addEventListener('visibilitychange', this.onVis);
    this.resize();
  }

  /**
   * @param {{dir:number, spd:number, sense?:string}} vec Direction VERS
   *   laquelle le courant porte, en degrés vrais, et sa vitesse en nœuds.
   * @param {number} [headingDeg] Cap du bateau. Sans lui, l'écran est orienté
   *   au nord — c'est moins parlant, mais c'est honnête : on ne prétend pas
   *   savoir où pointe l'étrave quand le compas se tait.
   */
  set(vec, headingDeg) {
    this.vec = vec;
    this.headingDeg = headingDeg;
    if (!this.raf && !document.hidden) this.play();
    this.draw();
  }

  play() {
    if (this.raf) return;
    this.last = performance.now();
    const step = (t) => {
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      // Une vague par 26 px, et 26 px parcourus par nœud et par seconde : à
      // deux nœuds la crête met une demi-seconde à traverser un intervalle,
      // ce qui se voit sans donner le mal de mer.
      this.phase = (this.phase + dt * 26 * Math.max(0.08, this.vec?.spd ?? 0)) % 26;
      this.draw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.pause();
    document.removeEventListener('visibilitychange', this.onVis);
    super.destroy();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();
    if (!this.vec) return;
    const font = getComputedStyle(document.body).fontFamily;
    const cx = w / 2;
    const cy = h / 2;

    /* Angle du courant RELATIF à l'étrave. Sans cap connu, on garde le nord en
     * haut plutôt que d'inventer une orientation. */
    const rel = norm360(this.vec.dir - (Number.isFinite(this.headingDeg) ? this.headingDeg : 0));
    const a = ((rel - 90) * Math.PI) / 180;

    const slack = this.vec.sense === 'slack' || (this.vec.spd ?? 0) < 0.15;
    const colour = slack ? '#64809d' : this.vec.sense === 'ebb' ? '#fb923c' : '#22d3ee';

    /* ---- Les vagues -------------------------------------------------------
     * Dessinées dans un repère tourné, sur un carré plus grand que le cadre :
     * une fois pivoté, un rectangle exact laisserait des coins vides. */
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(a + Math.PI / 2);
    const D = Math.hypot(w, h);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let y = -D / 2; y < D / 2; y += 26) {
      const yy = y + this.phase;
      const t = 1 - Math.abs(yy) / (D / 2);
      ctx.globalAlpha = Math.max(0, 0.1 + 0.42 * t);
      ctx.beginPath();
      // Un chevron par ligne, pointe vers l'aval : c'est la flèche que
      // l'utilisateur a demandée, répétée, qui devient un courant.
      for (let x = -D / 2; x < D / 2; x += 34) {
        ctx.moveTo(x, yy + 5);
        ctx.lineTo(x + 11, yy - 4);
        ctx.lineTo(x + 22, yy + 5);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    /* ---- La flèche maîtresse ---------------------------------------------- */
    if (!slack) {
      const L = Math.min(h * 0.34, 30);
      const tx = cx + Math.cos(a) * L;
      const ty = cy + Math.sin(a) * L;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.shadowColor = colour;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * L, cy - Math.sin(a) * L);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(a) * 9, ty + Math.sin(a) * 9);
      ctx.lineTo(tx + Math.cos(a + 2.5) * 11, ty + Math.sin(a + 2.5) * 11);
      ctx.lineTo(tx + Math.cos(a - 2.5) * 11, ty + Math.sin(a - 2.5) * 11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* ---- Le bateau, fixe, étrave en haut ---------------------------------- */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(7, 6);
    ctx.lineTo(0, 2);
    ctx.lineTo(-7, 6);
    ctx.closePath();
    ctx.fillStyle = '#e8f1fa';
    ctx.strokeStyle = '#0a1421';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* ---- Ce qu'il faut lire ----------------------------------------------- */
    ctx.fillStyle = 'rgba(10,20,33,.72)';
    ctx.fillRect(0, h - 20, w, 20);
    /* Deux étiquettes, une par bord, et une taille qui CÈDE avant le texte :
     * « VIENT DE L'EST-NORD-EST » plus la vitesse font 250 px à 11 px, pour un
     * canevas qui en fait 278 sur un iPhone SE — et moins dès qu'on met le
     * téléphone dans une coque. On rétrécit jusqu'à ce que ça tienne plutôt
     * que de couper un mot au milieu. */
    const left = this.label || '';
    const right = this.label2 || '';
    let size = 11;
    ctx.textBaseline = 'middle';
    while (size > 8) {
      ctx.font = `800 ${size}px ${font}`;
      if (ctx.measureText(left).width + ctx.measureText(right).width + 24 <= w) break;
      size -= 0.5;
    }
    ctx.fillStyle = colour;
    ctx.textAlign = 'left';
    ctx.fillText(left, 8, h - 10);
    if (right) {
      ctx.textAlign = 'right';
      ctx.fillText(right, w - 8, h - 10);
    }
  }
}

/* ==========================================================================
 * Méteogramme — une journée de vent et de mer
 * --------------------------------------------------------------------------
 * Vingt-quatre lignes de chiffres, personne ne les lit. Une courbe, si : on
 * voit d'un coup d'œil que le vent monte à partir de midi, ou que la matinée
 * est la seule fenêtre calme de la journée. C'est cette lecture-là qu'on vient
 * chercher quand on choisit son créneau.
 *
 * ── CE QUI EST DESSINÉ, ET DANS QUEL ORDRE ────────────────────────────────
 * 1. la NUIT en fond, du coucher au lever : sortir avant le jour n'est pas la
 *    même décision que sortir à midi, et la barre du fond le rappelle sans un
 *    mot ;
 * 2. la MER en aire bleue, sur son propre axe — c'est elle qui décide de la
 *    sortie sur un petit bateau, avant le vent ;
 * 3. les RAFALES en bande claire au-dessus du vent moyen : c'est l'écart entre
 *    les deux qui rend une journée pénible, pas le vent seul ;
 * 4. le VENT MOYEN en trait plein, avec l'échelle en nœuds à gauche.
 *
 * ── UNE SEULE ÉCHELLE DE VENT, JAMAIS AUTOMATIQUE À 100 % ─────────────────
 * L'échelle part de zéro et monte au moins à 20 nœuds même par temps calme.
 * Une échelle qui s'ajuste au maximum du jour donne exactement le même dessin
 * à une journée à 5 nœuds et à une journée à 35 : la courbe monte pareil, et
 * l'œil retient « ça souffle » dans les deux cas. C'est le pire mensonge qu'un
 * graphique puisse faire à quelqu'un qui décide de sortir en mer.
 * ========================================================================== */
export class Meteogram extends Canvas {
  constructor(parent, opts = {}) {
    super(parent, opts.height || 132);
    this.data = null;
    this.resize();
  }

  /**
   * @param {Array} hours Heures de la journée (0 h → 23 h), telles que rendues
   *   par data/weather.js.
   * @param {{sunriseT:number, sunsetT:number}} [sun] Lever et coucher du jour.
   * @param {number} [now] Instant courant, pour le repère vertical.
   */
  set(hours, sun, now) {
    this.data = { hours: hours || [], sun, now };
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    this.clearAll();
    const hours = this.data?.hours;
    if (!hours?.length) return;
    const { sun, now } = this.data;
    const font = getComputedStyle(document.body).fontFamily;

    const padL = 24;
    const padR = 26;
    const padT = 8;
    const padB = 16;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);

    // L'axe des temps couvre la JOURNÉE ENTIÈRE, pas seulement les heures
    // reçues : si la série commence à 07 h — cas d'aujourd'hui — la courbe doit
    // se placer à droite dans la journée, pas s'étaler sur toute la largeur
    // comme si elle la couvrait.
    const t0 = new Date(hours[0].t).setHours(0, 0, 0, 0);
    const t1 = t0 + 24 * 3600000;
    const X = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;

    const gustMax = Math.max(...hours.map((x) => x.windGustKn ?? 0));
    const windMax = Math.max(...hours.map((x) => x.windSpeedKn ?? 0));
    const top = Math.max(20, Math.ceil(Math.max(gustMax, windMax) / 5) * 5);
    const Y = (kn) => padT + plotH - (Math.max(0, kn) / top) * plotH;

    const waveVals = hours.map((x) => x.waveHeightM).filter((v) => typeof v === 'number');
    const waveTop = waveVals.length ? Math.max(1, Math.ceil(Math.max(...waveVals) * 2) / 2) : 0;
    const YW = (m) => padT + plotH - (Math.max(0, m) / waveTop) * plotH;

    /* ---- Grille horaire : 00, 06, 12, 18 ---- */
    ctx.font = `700 8px ${font}`;
    ctx.textAlign = 'center';
    for (let hh = 0; hh <= 24; hh += 6) {
      const x = X(t0 + hh * 3600000);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.strokeStyle = 'rgba(28,47,71,.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (hh < 24) {
        ctx.fillStyle = '#64809d';
        ctx.fillText(`${String(hh).padStart(2, '0')}h`, x, h - 4);
      }
    }

    /* ---- 1. la mer ---- */
    if (waveTop) {
      ctx.beginPath();
      let started = false;
      for (const x of hours) {
        if (typeof x.waveHeightM !== 'number') continue;
        const px = X(x.t);
        const py = YW(x.waveHeightM);
        if (!started) { ctx.moveTo(px, padT + plotH); started = true; }
        ctx.lineTo(px, py);
      }
      if (started) {
        ctx.lineTo(X(hours[hours.length - 1].t), padT + plotH);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        g.addColorStop(0, 'rgba(59,130,246,.42)');
        g.addColorStop(1, 'rgba(59,130,246,.05)');
        ctx.fillStyle = g;
        ctx.fill();
      }
    }

    /* ---- 2. la nuit, PAR-DESSUS l'aire de mer ----
     * Elle était dessinée en premier, sous tout le reste : l'aire de mer, qui
     * est opaque en bas, la recouvrait entièrement — la nuit ne se voyait plus
     * du tout aux heures qui comptent, celles où l'on part avant le jour. Posée
     * par-dessus, en voile léger, elle assombrit la zone sans effacer ce qui
     * est dessous. Elle reste sous les courbes de vent, qui doivent rester
     * franches. */
    if (sun?.sunriseT && sun?.sunsetT) {
      ctx.fillStyle = 'rgba(3,7,14,.42)';
      const dawn = Math.max(t0, Math.min(t1, sun.sunriseT));
      const dusk = Math.max(t0, Math.min(t1, sun.sunsetT));
      ctx.fillRect(padL, padT, X(dawn) - padL, plotH);
      ctx.fillRect(X(dusk), padT, padL + plotW - X(dusk), plotH);
      // Deux traits fins aux bornes : sans eux, un voile de 42 % se confond
      // avec une variation de dégradé et personne ne sait où le jour se lève.
      ctx.strokeStyle = 'rgba(251,191,36,.35)';
      ctx.lineWidth = 1;
      for (const x of [X(dawn), X(dusk)]) {
        if (x <= padL + 1 || x >= padL + plotW - 1) continue;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
      }
    }

    /* ---- 3. les rafales ---- */
    ctx.beginPath();
    hours.forEach((x, i) => {
      const px = X(x.t);
      const py = Y(x.windGustKn ?? x.windSpeedKn ?? 0);
      return i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    for (let i = hours.length - 1; i >= 0; i--) {
      ctx.lineTo(X(hours[i].t), Y(hours[i].windSpeedKn ?? 0));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(251,191,36,.22)';
    ctx.fill();

    /* ---- 4. le vent moyen ---- */
    ctx.beginPath();
    hours.forEach((x, i) => {
      const px = X(x.t);
      const py = Y(x.windSpeedKn ?? 0);
      return i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    /* ---- Échelles chiffrées ----
     * Le vent à gauche en nœuds, la mer à droite en mètres. Sans les unités
     * écrites, deux courbes sur deux axes différents se lisent comme deux
     * courbes sur le même — et on croit que la mer double quand c'est le vent. */
    ctx.font = `700 8px ${font}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(`${top}`, padL - 3, padT + 7);
    ctx.fillText('nd', padL - 3, padT + 17);
    ctx.fillText('0', padL - 3, padT + plotH);

    if (waveTop) {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#7dd3fc';
      ctx.fillText(`${waveTop.toFixed(1)}`, padL + plotW + 3, padT + 7);
      ctx.fillText('m', padL + plotW + 3, padT + 17);
    }

    /* ---- Maintenant ---- */
    if (now >= t0 && now <= t1) {
      const x = X(now);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.strokeStyle = 'rgba(232,241,250,.75)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

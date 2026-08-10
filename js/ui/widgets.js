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

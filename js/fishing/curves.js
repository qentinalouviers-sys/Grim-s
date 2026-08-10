/* ==========================================================================
 * fishing/curves.js — primitives de scoring
 * --------------------------------------------------------------------------
 * Toutes continues et dérivables aux bords : un score horaire ne doit pas
 * présenter de marche d'escalier sur un graphe. C'est ce qui permet de lire
 * une fenêtre de pêche comme une pente, et pas comme une suite de paliers.
 * ========================================================================== */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Cloche : 1 au centre, 0 au-delà de halfWidth, décroissance en cosinus. */
export function bell(x, center, halfWidth) {
  const d = Math.abs(x - center) / halfWidth;
  if (d >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * d));
}

/** Plateau à 1 entre lo et hi, transitions douces de largeur soft. */
export function plateau(x, lo, hi, soft) {
  const rise = smoothstep(lo - soft, lo, x);
  const fall = 1 - smoothstep(hi, hi + soft, x);
  return clamp01(Math.min(rise, fall));
}

/** Rampe montante : 0 sous lo, 1 au-dessus de hi. */
export const ramp = (x, lo, hi) => smoothstep(lo, hi, x);

/** Rampe descendante. */
export const rampDown = (x, lo, hi) => 1 - smoothstep(lo, hi, x);

/**
 * Remonte le plancher d'un facteur : floorAt(f, 0.5) mappe 0..1 sur 0.5..1.
 * Sert à distinguer « c'est un bonus » de « c'est une condition bloquante ».
 */
export const floorAt = (value, min) => min + (1 - min) * clamp01(value);

/** Moyenne pondérée, en ignorant les facteurs dont la valeur est null. */
export function weightedMean(entries) {
  const used = entries.filter(
    (e) => e.value !== null && e.value !== undefined && Number.isFinite(e.value),
  );
  const totalWeight = used.reduce((acc, e) => acc + e.weight, 0);
  if (totalWeight === 0) return { value: 0, used, coverage: 0 };
  const sum = used.reduce((acc, e) => acc + e.weight * e.value, 0);
  const declared = entries.reduce((acc, e) => acc + e.weight, 0);
  return { value: sum / totalWeight, used, coverage: totalWeight / declared };
}

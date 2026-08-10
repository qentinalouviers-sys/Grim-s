/* ==========================================================================
 * data/harmonics.js — prédiction de marée par constituants harmoniques
 * --------------------------------------------------------------------------
 * LA décision d'architecture de cette app.
 *
 * L'approche « on télécharge la courbe SHOM tous les jours » a un défaut
 * rédhibitoire : elle ne marche que si on a du réseau AVANT de partir, et
 * elle donne 7 jours d'horizon. Or on planifie une sortie trois semaines à
 * l'avance, et on part parfois sans avoir rouvert l'app depuis quinze jours.
 *
 * Ici la marée est CALCULÉE à bord :
 *
 *     h(t) = Z0 + Σ  f_i(t) · A_i · cos( V_i(t) + u_i(t) − g_i )
 *
 * 23 constituants, corrections nodales incluses. Horizon infini, zéro octet
 * de réseau, quelques millisecondes pour 24 h de courbe. La couche
 * data/tide.js préfère la donnée SHOM quand elle est fraîche et bascule
 * ici sans discontinuité sinon.
 *
 * ── ORIGINE DES CONSTANTES ────────────────────────────────────────────────
 * data/harmonics-dieppe.json est AJUSTÉ automatiquement : scripts/fit_harmonics.py
 * fait une régression linéaire (moindres carrés sur les composantes en
 * cos/sin, donc solution exacte, pas d'itération) de la série SHOM réelle sur
 * ces 23 constituants, et réécrit le fichier. Le workflow GitHub le relance
 * régulièrement. Le fichier livré au départ porte `provisional: true` : les
 * amplitudes viennent des niveaux caractéristiques publiés (PMVE/PMME/BMME/
 * BMVE), les phases sont estimées. L'UI l'affiche sans ambiguïté tant que le
 * premier ajustement n'a pas tourné.
 *
 * ── CONVENTION ────────────────────────────────────────────────────────────
 * Le fitter Python et ce module partagent EXACTEMENT la même construction
 * d'argument astronomique (mêmes nombres de Doodson, mêmes corrections
 * nodales, même origine des phases). C'est ce qui rend l'ajustement
 * auto-cohérent : une erreur de convention serait absorbée dans les phases
 * ajustées et n'aurait aucun effet sur la prédiction. Ne pas modifier
 * DOODSON ou nodal() d'un côté sans l'autre.
 * ========================================================================== */

import { toRad, norm360 } from '../core/geo.js';

const J2000 = 2451545.0;
const DAY_MS = 86400000;
const sin = (d) => Math.sin(toRad(d));
const cos = (d) => Math.cos(toRad(d));

/**
 * Nombres de Doodson : coefficients sur [t, s, h, p, N', p1] plus un
 * multiple de 90° de décalage.
 *   t  = temps solaire moyen (15°/h)
 *   s  = longitude moyenne de la Lune
 *   h  = longitude moyenne du Soleil
 *   p  = longitude du périgée lunaire
 *   N' = −N (nœud ascendant), traité par les corrections nodales
 *   p1 = longitude du périgée solaire
 * La colonne `nodal` désigne la famille de correction f/u.
 */
export const DOODSON = {
  // semi-diurnes
  M2:   { n: [2, -2,  2,  0, 0, 0], q: 0, nodal: 'M2' },
  S2:   { n: [2,  0,  0,  0, 0, 0], q: 0, nodal: 'none' },
  N2:   { n: [2, -3,  2,  1, 0, 0], q: 0, nodal: 'M2' },
  K2:   { n: [2,  0,  2,  0, 0, 0], q: 0, nodal: 'K2' },
  L2:   { n: [2, -1,  2, -1, 0, 0], q: 2, nodal: 'M2' },
  T2:   { n: [2,  0, -1,  0, 0, 1], q: 0, nodal: 'none' },
  '2N2':{ n: [2, -4,  2,  2, 0, 0], q: 0, nodal: 'M2' },
  MU2:  { n: [2, -4,  4,  0, 0, 0], q: 0, nodal: 'M2' },
  NU2:  { n: [2, -3,  4, -1, 0, 0], q: 0, nodal: 'M2' },
  LDA2: { n: [2, -1,  0,  1, 0, 0], q: 2, nodal: 'M2' },
  // diurnes (marginaux en Manche, gardés pour la qualité de l'ajustement)
  K1:   { n: [1,  0,  1,  0, 0, 0], q: 1, nodal: 'K1' },
  O1:   { n: [1, -2,  1,  0, 0, 0], q: 3, nodal: 'O1' },
  P1:   { n: [1,  0, -1,  0, 0, 0], q: 3, nodal: 'none' },
  Q1:   { n: [1, -3,  1,  1, 0, 0], q: 3, nodal: 'O1' },
  S1:   { n: [1,  0,  0,  0, 0, 0], q: 0, nodal: 'none' },
  // eaux peu profondes — ce sont elles qui donnent à la Manche orientale son
  // asymétrie flot/jusant et sa tenue de pleine mer. Les ignorer coûte 30 cm.
  M4:   { n: [4, -4,  4,  0, 0, 0], q: 0, nodal: 'M4' },
  MS4:  { n: [4, -2,  2,  0, 0, 0], q: 0, nodal: 'M2' },
  MN4:  { n: [4, -5,  4,  1, 0, 0], q: 0, nodal: 'M4' },
  M6:   { n: [6, -6,  6,  0, 0, 0], q: 0, nodal: 'M6' },
  '2MS6':{n: [6, -4,  4,  0, 0, 0], q: 0, nodal: 'M4' },
  MSF:  { n: [0,  2, -2,  0, 0, 0], q: 0, nodal: 'none' },
  MM:   { n: [0,  1,  0, -1, 0, 0], q: 0, nodal: 'MM' },
  MF:   { n: [0,  2,  0,  0, 0, 0], q: 0, nodal: 'MF' },
};

/** Angles astronomiques fondamentaux, en degrés, à l'instant epoch ms. */
export function astroArgs(ms) {
  const jd = ms / DAY_MS + 2440587.5;
  const T = (jd - J2000) / 36525;
  const d = jd - J2000;

  const s  = norm360(218.3164477 + 481267.88123421 * T);
  const h  = norm360(280.4662556 + 36000.7698300 * T);
  const p  = norm360(83.3532465  + 4069.0137287 * T);
  const N  = norm360(125.0445479 - 1934.1362891 * T);
  const p1 = norm360(282.9373400 + 1.7195366 * T);

  // Temps solaire moyen en degrés depuis minuit UT.
  const frac = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  const tDeg = (frac / DAY_MS) * 360;

  return { t: tDeg, s, h, p, N, p1, T, d };
}

/**
 * Facteur f (amplitude) et déphasage u (degrés) des corrections nodales.
 * Séries classiques de Schureman exprimées en fonction de N.
 */
export function nodal(family, N) {
  const c1 = cos(N), c2 = cos(2 * N), c3 = cos(3 * N);
  const s1 = sin(N), s2 = sin(2 * N), s3 = sin(3 * N);
  switch (family) {
    case 'M2': {
      const f = 1.0004 - 0.0373 * c1 + 0.0002 * c2;
      return { f, u: -2.14 * s1 };
    }
    case 'K1':
      return {
        f: 1.006 + 0.115 * c1 - 0.0088 * c2 + 0.0006 * c3,
        u: -8.86 * s1 + 0.68 * s2 - 0.07 * s3,
      };
    case 'O1':
      return {
        f: 1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3,
        u: 10.8 * s1 - 1.34 * s2 + 0.19 * s3,
      };
    case 'K2':
      return {
        f: 1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3,
        u: -17.74 * s1 + 0.68 * s2 - 0.04 * s3,
      };
    case 'M4': {
      const m = nodal('M2', N);
      return { f: m.f * m.f, u: 2 * m.u };
    }
    case 'M6': {
      const m = nodal('M2', N);
      return { f: m.f ** 3, u: 3 * m.u };
    }
    case 'MM':
      return { f: 1.0 - 0.13 * c1 + 0.0013 * c2, u: 0 };
    case 'MF':
      return { f: 1.0429 + 0.4135 * c1 - 0.004 * c2, u: -23.74 * s1 + 2.68 * s2 - 0.38 * s3 };
    default:
      return { f: 1, u: 0 };
  }
}

/**
 * Modèle de marée pour un port.
 * @param {{ z0:number, meanSpringRange:number, constituents:Record<string,{A:number,g:number}> }} spec
 */
export class TideModel {
  constructor(spec) {
    this.z0 = spec.z0;
    this.meanSpringRange = spec.meanSpringRange || 8.5;
    this.provisional = !!spec.provisional;
    this.datum = spec.datum || 'ZH (zéro hydrographique)';
    this.port = spec.port || 'Dieppe';
    this.fittedAt = spec.fittedAt || null;
    this.rmsM = spec.rmsM ?? null;

    this.terms = Object.entries(spec.constituents)
      .filter(([name, c]) => DOODSON[name] && Number.isFinite(c.A) && c.A > 0)
      .map(([name, c]) => ({ name, A: c.A, g: c.g, ...DOODSON[name] }));
  }

  /** Hauteur d'eau au-dessus du zéro des cartes, en mètres. */
  height(ms) {
    const a = astroArgs(ms);
    let h = this.z0;
    for (const term of this.terms) {
      const [i1, i2, i3, i4, , i6] = term.n;
      const V = i1 * a.t + i2 * a.s + i3 * a.h + i4 * a.p + i6 * a.p1 + term.q * 90;
      const nd = nodal(term.nodal, a.N);
      h += nd.f * term.A * cos(V + nd.u - term.g);
    }
    return h;
  }

  /** dh/dt en m/h — c'est ce dont dépend tout le modèle de courant. */
  rate(ms, dtMs = 300000) {
    return ((this.height(ms + dtMs) - this.height(ms - dtMs)) / (2 * dtMs)) * 3600000;
  }

  /**
   * Courbe échantillonnée.
   * @returns {{t:number, heightM:number}[]}
   */
  series(fromMs, toMs, stepMs = 300000) {
    const out = [];
    for (let t = fromMs; t <= toMs; t += stepMs) out.push({ t, heightM: this.height(t) });
    return out;
  }

  /**
   * Pleines et basses mers. Balayage à 4 min puis raffinement parabolique sur
   * la dérivée : précision meilleure que 15 s, ce qui est très en dessous de
   * l'incertitude du modèle lui-même.
   * @returns {{t:number, heightM:number, kind:'HW'|'LW', coefficient:number|null}[]}
   */
  extrema(fromMs, toMs) {
    const step = 240000;
    const out = [];
    let prevRate = this.rate(fromMs);
    for (let t = fromMs + step; t <= toMs; t += step) {
      const r = this.rate(t);
      if (prevRate === 0 || Math.sign(r) === Math.sign(prevRate)) {
        prevRate = r;
        continue;
      }
      // Zéro de la dérivée entre t-step et t : interpolation linéaire puis
      // une passe de Newton sur la dérivée pour absorber la courbure.
      let te = t - step + (step * prevRate) / (prevRate - r);
      for (let i = 0; i < 3; i++) {
        const rr = this.rate(te);
        const drr = (this.rate(te + 60000) - this.rate(te - 60000)) / 120000;
        if (!drr) break;
        te -= rr / drr;
      }
      out.push({
        t: Math.round(te),
        heightM: this.height(te),
        kind: prevRate > 0 ? 'HW' : 'LW',
      });
      prevRate = r;
    }
    this.#assignCoefficients(out);
    return out;
  }

  /**
   * Coefficient de marée à la française.
   * Défini comme le marnage rapporté au marnage moyen de vive-eau (× 100),
   * affecté à la pleine mer. On l'attribue aussi à la basse mer qui suit,
   * comme le font les annuaires. Bornes 20–120 : au-delà, c'est un artefact
   * de bord de série, pas une marée du siècle.
   */
  #assignCoefficients(ext) {
    for (let i = 0; i < ext.length; i++) {
      const e = ext[i];
      const neighbours = [ext[i - 1], ext[i + 1]].filter((x) => x && x.kind !== e.kind);
      if (!neighbours.length) {
        e.coefficient = null;
        continue;
      }
      const range = Math.max(...neighbours.map((n) => Math.abs(e.heightM - n.heightM)));
      e.coefficient = Math.max(20, Math.min(120, Math.round((range / this.meanSpringRange) * 100)));
    }
  }

  /** Coefficient interpolé en continu — utilisé par le scoring pêche. */
  coefficientAt(ms, ext) {
    const list = (ext || this.extrema(ms - 18 * 3600000, ms + 18 * 3600000)).filter(
      (e) => e.coefficient != null,
    );
    if (!list.length) return 70;
    if (list.length === 1) return list[0].coefficient;
    let a = list[0];
    let b = list[list.length - 1];
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].t <= ms && list[i + 1].t >= ms) {
        a = list[i];
        b = list[i + 1];
        break;
      }
    }
    if (b.t === a.t) return a.coefficient;
    const f = Math.max(0, Math.min(1, (ms - a.t) / (b.t - a.t)));
    return Math.round(a.coefficient + f * (b.coefficient - a.coefficient));
  }

  /**
   * Contrôle qualité : écart RMS entre ce modèle et une série de référence.
   * Sert au bandeau « modèle calé à ±X cm sur la donnée SHOM ». Une app de
   * navigation doit dire ce qu'elle vaut.
   */
  rmsAgainst(reference) {
    if (!reference?.length) return null;
    let sum = 0;
    for (const p of reference) sum += (this.height(p.t) - p.heightM) ** 2;
    return Math.sqrt(sum / reference.length);
  }
}

/**
 * Repli absolu si même le fichier de constantes est introuvable (premier
 * lancement hors ligne, cache vide). Modèle M2+S2 pur calé sur les niveaux
 * caractéristiques de Dieppe : les heures peuvent glisser d'une demi-heure,
 * mais on ne montre jamais un écran vide à quelqu'un qui est déjà en mer.
 */
export const EMERGENCY_SPEC = {
  port: 'Dieppe',
  z0: 4.9,
  meanSpringRange: 8.5,
  provisional: true,
  constituents: {
    M2: { A: 3.3, g: 322 },
    S2: { A: 0.95, g: 2 },
    N2: { A: 0.62, g: 300 },
    M4: { A: 0.26, g: 165 },
  },
};

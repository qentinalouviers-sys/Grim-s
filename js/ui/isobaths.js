/* ==========================================================================
 * ui/isobaths.js — les lignes de niveau du fond, calculées à bord
 * --------------------------------------------------------------------------
 * Une carte de fonds, ce sont deux choses : des SONDES (des chiffres posés sur
 * l'eau) et des ISOBATHES (les lignes qui joignent les points de même
 * profondeur). Les chiffres, l'app les a — le carnet de sondes du bord. Les
 * lignes, il faut les calculer, et c'est ce que fait ce module.
 *
 * ── POURQUOI ON LES CALCULE AU LIEU DE LES TÉLÉCHARGER ────────────────────
 * EMODnet publie bien un jeu de contours, en CC-BY. Ses valeurs commencent à
 * CINQUANTE MÈTRES. Pour un pêcheur côtier qui travaille entre 5 et 30 m,
 * c'est une couche vide : la première ligne est déjà plus profonde que tout
 * son terrain. Il faut donc les tirer soi-même du modèle numérique de terrain,
 * aux profondeurs qui comptent — 5, 10, 15, 20, 30, 40 m.
 *
 * ── L'ALGORITHME, ET POURQUOI CELUI-LÀ ────────────────────────────────────
 * Marching squares, en segments indépendants. On parcourt la grille case par
 * case ; pour chaque carré de quatre sommets, on regarde lesquels sont
 * au-dessus du seuil et on trace le segment qui coupe. Les segments ne sont
 * PAS chaînés en polylignes continues : ça coûterait un tri et un recollement
 * pour un gain purement esthétique, et à l'échelle du dessin les segments
 * bout à bout se lisent comme une ligne. Sur un téléphone qui doit aussi tenir
 * le GPS, la simplicité vaut mieux que la beauté.
 *
 * ── CE QU'UNE ISOBATHE DE CE MODÈLE VAUT, ET NE VAUT PAS ──────────────────
 * La grille fait une centaine de mètres de maille. La ligne des 10 m qui en
 * sort décrit la forme générale du plateau, pas le tracé hydrographique. Elle
 * NE REMPLACE PAS une carte marine, et l'app le dit à l'écran plutôt que dans
 * une note de bas de page — une ligne bien dessinée inspire une confiance que
 * sa source ne mérite pas.
 * ========================================================================== */

import * as bathy from '../data/bathy.js';

/* Les profondeurs qui comptent en pêche côtière de la Manche orientale.
 * Au-delà de 40 m on est sorti du terrain de jeu, et en dessous de 5 m on est
 * dans les cailloux où l'on ne navigue pas à la carte mais à vue. */
export const LEVELS = [5, 10, 15, 20, 30, 40];

/* Du clair au sombre en descendant : c'est la convention de toutes les cartes
 * marines, et l'inverser ferait lire un haut-fond comme une fosse. */
const COLOR = {
  5: '#7dd3fc',
  10: '#5ab4e8',
  15: '#4295d4',
  20: '#3b82f6',
  30: '#3163c4',
  40: '#28468f',
};

/**
 * Construit la couche. Rien n'est dessiné tant que `refresh()` n'a pas été
 * appelé avec une emprise : une carte du monde entier en isobathes serait
 * cinquante mille segments pour rien.
 */
export function create(L) {
  const group = L.layerGroup();
  group.__L = L;
  return group;
}

/** Y a-t-il de quoi dessiner ? L'interface le demande avant de proposer. */
export const available = () => bathy.ready();

/**
 * Redessine les isobathes de l'emprise visible.
 *
 * @param {object} group  La couche rendue par create().
 * @param {object} bounds Emprise Leaflet.
 * @param {number} zoom   Niveau de zoom courant.
 * @returns {{segments:number, levels:number[]}} Ce qui a été tracé.
 */
export function refresh(group, bounds, zoom) {
  const L = group.__L;
  group.clearLayers();
  if (!bathy.ready()) return { segments: 0, levels: [] };

  /* En dessous du zoom 11, une isobathe de cent mètres de maille produit une
   * dentelle illisible qui masque la carte. On ne dessine pas plutôt que de
   * dessiner mal. */
  if (zoom < 11) return { segments: 0, levels: [] };

  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  // Aux échelles moyennes, une ligne sur deux : six niveaux superposés sur un
  // écran de téléphone se touchent et forment un aplat.
  const levels = zoom >= 13 ? LEVELS : LEVELS.filter((d) => d % 10 === 0);

  let count = 0;
  for (const level of levels) {
    const segs = contour(level, south, west, north, east);
    if (!segs.length) continue;
    count += segs.length;
    const poly = L.polyline(segs, {
      color: COLOR[level] || '#3b82f6',
      weight: level % 10 === 0 ? 1.6 : 1.1,
      opacity: 0.75,
      interactive: false,
      // `noClip` : les segments sont déjà bornés à l'emprise, et le découpage
      // de Leaflet sur des milliers de micro-segments coûte plus qu'il ne rend.
      noClip: true,
    });
    poly.addTo(group);

    /* L'étiquette de profondeur, une seule par niveau et par écran. Sans elle
     * on voit des lignes bleues sans savoir laquelle est laquelle — et c'est
     * exactement l'information qu'on est venu chercher. */
    const mid = segs[Math.floor(segs.length / 2)];
    if (mid && zoom >= 12) {
      L.marker(mid[0], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: '',
          html: `<span class="iso-lbl" style="color:${COLOR[level]}">${level}</span>`,
          iconSize: [22, 12],
          iconAnchor: [11, 6],
        }),
      }).addTo(group);
    }
  }
  return { segments: count, levels };
}

/* ==========================================================================
 * Marching squares
 * ========================================================================== */

/**
 * Les segments de l'isobathe `level` dans l'emprise donnée.
 * @returns {Array<Array<[number,number]>>} paires [[lat,lon],[lat,lon]]
 */
function contour(level, south, west, north, east) {
  const out = [];

  /* On échantillonne la grille par ses propres coordonnées plutôt que par un
   * pas arbitraire : sinon on ré-interpole une donnée déjà interpolée, et les
   * lignes se mettent à onduler pour des raisons qui n'ont rien à voir avec le
   * fond. `depthAt` rend la valeur de la maille, on avance donc d'une maille. */
  const m = gridStep();
  if (!m) return out;
  const { dLat, dLon } = m;

  // Marge d'une maille : une ligne qui frôle le bord de l'écran doit être
  // tracée jusqu'au bord, pas s'arrêter une case avant.
  const lat0 = south - dLat;
  const lat1 = north + dLat;
  const lon0 = west - dLon;
  const lon1 = east + dLon;

  // Garde-fou : une emprise trop large ferait des dizaines de milliers de
  // cases. On plafonne, et l'appelant a déjà refusé les petits zooms.
  const nLat = Math.ceil((lat1 - lat0) / dLat);
  const nLon = Math.ceil((lon1 - lon0) / dLon);
  if (nLat * nLon > 40000) return out;

  for (let i = 0; i < nLat; i++) {
    const la = lat0 + i * dLat;
    const lb = la + dLat;
    for (let j = 0; j < nLon; j++) {
      const lo = lon0 + j * dLon;
      const lp = lo + dLon;

      // Les quatre sommets du carré, dans le sens trigonométrique.
      const v = [
        bathy.depthAt(la, lo),
        bathy.depthAt(la, lp),
        bathy.depthAt(lb, lp),
        bathy.depthAt(lb, lo),
      ];
      // Une case qui touche la terre ou une absence de donnée est ignorée :
      // interpoler entre une profondeur et « je ne sais pas » invente un trait.
      if (v.some((x) => x == null)) continue;

      const pts = [[la, lo], [la, lp], [lb, lp], [lb, lo]];
      const above = v.map((x) => x >= level);
      const crossing = [];
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        if (above[k] === above[k2]) continue;
        // Interpolation linéaire sur l'arête : la position exacte du passage.
        const t = (level - v[k]) / (v[k2] - v[k]);
        crossing.push([
          pts[k][0] + (pts[k2][0] - pts[k][0]) * t,
          pts[k][1] + (pts[k2][1] - pts[k][1]) * t,
        ]);
      }
      // Deux passages : un segment. Quatre : un col, cas ambigu du marching
      // squares — on relie par paires dans l'ordre, ce qui donne l'une des
      // deux résolutions possibles. À cette échelle l'écart est invisible.
      if (crossing.length === 2) out.push(crossing);
      else if (crossing.length === 4) {
        out.push([crossing[0], crossing[1]]);
        out.push([crossing[2], crossing[3]]);
      }
    }
  }
  return out;
}

/** Le pas de la grille, lu dans le modèle. */
function gridStep() {
  const meta = bathy.meta();
  if (!meta) return null;
  // `resolutionM` est la maille en latitude ; on redéduit les deux pas en
  // degrés, car c'est ce qui sert à parcourir la grille.
  const dLat = meta.resolutionM / 111320;
  return { dLat, dLon: dLat / 0.64 };
}

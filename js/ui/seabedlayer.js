/* ==========================================================================
 * ui/seabedlayer.js — la nature des fonds, dessinée
 * --------------------------------------------------------------------------
 * La carte des fonds est embarquée depuis EMODnet et l'app s'en sert déjà :
 * elle score les postes avec, elle pré-remplit le fond quand on note une
 * prise, elle l'affiche dans la fiche d'une marque. Mais on ne pouvait pas LA
 * VOIR. C'était le défaut le plus bête de l'app — la donnée la plus utile à
 * un pêcheur, présente, calculée, et invisible.
 *
 * ── POURQUOI DES CASES, ET PAS UN JOLI DÉGRADÉ ────────────────────────────
 * La source est cartographiée au 1:250 000 et rastérisée à ~280 m. Un rendu
 * lissé donnerait des contours nets qui n'existent pas dans la donnée : on
 * croirait lire une limite de sédiment au mètre près, alors qu'elle est
 * connue à trois cents mètres. Les cases carrées disent la vérité sur la
 * résolution, et elles la disent sans une ligne de texte.
 *
 * ── POURQUOI UNE COUCHE DE TUILES ─────────────────────────────────────────
 * Leaflet met les tuiles en cache, les recycle au déplacement et ne redessine
 * que ce qui entre dans le champ. Un unique canevas plein écran redessiné à
 * chaque frame de déplacement ferait ramer la carte sur un téléphone — et
 * c'est justement en déplacement qu'on la regarde.
 * ========================================================================== */

import * as seabed from '../data/seabed.js';
import { el } from './dom.js';

/* Palette. Les teintes de la carte marine : le sable clair, le gravier ocre,
 * la roche grise, la vase brune. Assez saturées pour se distinguer sous un
 * filtre rouge de mode nuit, assez transparentes pour laisser lire la carte
 * en dessous — c'est une information de fond, pas un fond de carte. */
const COLOURS = {
  sable: '#d8c584',
  'sable-coquillier': '#c2914d',
  roche: '#8d96a8',
  vase: '#6d6047',
  'sablo-vaseux': '#a49a6d',
};
const ALPHA = 0.36;

/* En dessous de ce zoom, une case de 280 m fait moins d'un pixel : on
 * peindrait cent vingt mille rectangles par tuile pour un aplat gris, et la
 * carte ramerait exactement au moment où l'on fait défiler le secteur. */
const MIN_ZOOM = 10;

/** Couleur d'une classe de fond, ou null si on ne la cartographie pas. */
export function colourOf(cls) {
  if (!cls?.habitat) return null;
  return COLOURS[cls.habitat] || null;
}

/**
 * Couche Leaflet. Elle se construit même sans données : elle ne dessine alors
 * rien, comme tout ce qui est optionnel dans cette app.
 *
 * @param {object} L Leaflet
 */
export function create(L) {
  const Layer = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      if (!seabed.ready()) return tile;

      const ctx = tile.getContext('2d');
      const nw = this._map.unproject([coords.x * size.x, coords.y * size.y], coords.z);
      const se = this._map.unproject([(coords.x + 1) * size.x, (coords.y + 1) * size.y], coords.z);
      const g = seabed.grid();
      if (!g) return tile;

      // Bornes de la tuile EN CASES, pas en pixels : on parcourt la grille et
      // on peint des rectangles, au lieu d'interroger la grille pixel par
      // pixel. À 280 m de maille et zoom 13, une tuile fait dix-sept cases de
      // large — dix-sept fois moins de travail que 256 lectures.
      const i0 = Math.floor((se.lat - g.south) / g.dLat) - 1;
      const i1 = Math.ceil((nw.lat - g.south) / g.dLat) + 1;
      const j0 = Math.floor((nw.lng - g.west) / g.dLon) - 1;
      const j1 = Math.ceil((se.lng - g.west) / g.dLon) + 1;

      const px = (lat, lon) => {
        const p = this._map.project([lat, lon], coords.z);
        return [p.x - coords.x * size.x, p.y - coords.y * size.y];
      };

      for (let i = Math.max(0, i0); i <= Math.min(g.rows - 1, i1); i++) {
        for (let j = Math.max(0, j0); j <= Math.min(g.cols - 1, j1); j++) {
          const v = g.cells[i * g.cols + j];
          if (!v) continue;
          const colour = colourOf(g.classes[v]);
          if (!colour) continue;
          const latS = g.south + i * g.dLat;
          const latN = latS + g.dLat;
          const lonW = g.west + j * g.dLon;
          const lonE = lonW + g.dLon;
          const [x0, y1] = px(latS, lonW);
          const [x1, y0] = px(latN, lonE);
          ctx.fillStyle = colour;
          // +1 px : sans ça un liseré du fond de carte transparaît entre deux
          // cases voisines de même couleur, et le rendu prend un air de
          // damier qui n'a aucun sens physique.
          ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        }
      }
      return tile;
    },
  });
  return new Layer({ opacity: ALPHA, minZoom: MIN_ZOOM, pane: 'tilePane', className: 'seabed-tiles' });
}

/**
 * Légende. Elle ne liste que les fonds RÉELLEMENT présents dans le secteur
 * embarqué : une légende qui annonce des vasières là où il n'y en a pas
 * apprend une fausse géographie.
 *
 * @param {boolean} compact Version courte, pour la surcouche de la carte. La
 *   mise en garde reste — elle est le mode d'emploi de la donnée, pas une
 *   mention légale — mais tenue en une ligne : posée en trois lignes au-dessus
 *   de la carte, elle poussait la légende hors du cadre et on ne lisait ni
 *   l'une ni l'autre.
 */
export function legend({ compact = false } = {}) {
  const box = el('div', 'seabed-legend');
  for (const c of seabed.classes()) {
    const colour = colourOf(c);
    if (!colour) continue;
    const row = el('div', 'seabed-key');
    const sw = el('span', 'seabed-swatch');
    sw.style.background = colour;
    row.append(sw, el('span', null, c.fr));
    box.append(row);
  }
  const m = seabed.meta();
  if (m) {
    box.append(el('div', 'tiny', compact
      ? `Sédiment dominant · maille ${m.resolutionM} m`
      : `${m.source} · maille ${m.resolutionM} m. Sédiment DOMINANT de la case : une tête de roche isolée au milieu du sable n’y figure pas.`));
  }
  return box;
}

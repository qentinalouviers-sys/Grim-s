/* ==========================================================================
 * ui/mntimport.js — installer un modèle de fonds depuis le téléphone
 * --------------------------------------------------------------------------
 * Le modèle numérique de terrain se télécharge une fois sur le portail du
 * SHOM. Jusqu'ici il fallait ensuite lancer un script Python sur le dépôt —
 * une marche que personne ne monte, et qui rendait toute la fonction
 * inaccessible à celui qui l'utilise. On la supprime : le fichier téléchargé
 * se donne directement à l'app, qui le réduit elle-même.
 *
 * ── POURQUOI ON NE CHARGE PAS LE FICHIER EN MÉMOIRE ───────────────────────
 * Une dalle de MNT fait cent à trois cents mégaoctets de texte. `file.text()`
 * en ferait une chaîne unique — donc deux fois ça en mémoire une fois décodée
 * en UTF-16 — et l'onglet meurt sur un téléphone. On lit donc en FLUX, par
 * morceaux, en n'accumulant que la grille de sortie : cent seize mille cases,
 * soit moins de deux mégaoctets, quelle que soit la taille de l'entrée.
 *
 * ── CE QU'ON GARDE, ET CE QU'ON JETTE ─────────────────────────────────────
 * On ne garde que l'emprise de l'app. Une dalle de façade couvre la Manche et
 * le golfe de Gascogne ; nous n'avons besoin que du Tréport à Fécamp. Tout le
 * reste est lu et jeté au fil de l'eau, sans jamais toucher le disque.
 *
 * ── LES MÊMES GARDE-FOUS QUE LE SCRIPT ────────────────────────────────────
 * Signe des profondeurs, terre, vraisemblance du coin nord-ouest. Ce sont eux
 * qui ont déjà attrapé un rendu colorié pris pour un relief. Ils sont ici
 * mot pour mot, parce qu'un fichier importé depuis un téléphone n'est pas plus
 * sûr qu'un fichier téléchargé par un script.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as idb from '../core/idb.js';
import * as bathy from '../data/bathy.js';
import { emit } from '../core/store.js';

/* L'emprise embarquée — la même que la carte des fonds et les épaves, pour que
 * les trois couches se superposent exactement. */
const SOUTH = 49.55;
const NORTH = 50.25;
const WEST = 0.35;
const EAST = 1.85;

/* Maille visée. 0,003° = 334 m en latitude. On agrège la source plutôt que de
 * la rééchantillonner : moyenner trois mailles de 111 m est honnête, prétendre
 * en fabriquer une de 50 m ne l'est pas. */
const TARGET_D = 0.003;

const LAND = 32767;
const NODATA = 32766;

/* Le coin nord-ouest est à trente milles au large de Fécamp, donc sous 5 à
 * 90 m d'eau. Toute grille qui prétend autre chose est refusée. */
const SANITY_MIN = 5;
const SANITY_MAX = 90;

/* ==========================================================================
 * L'écran
 * ========================================================================== */
export function openMntImport({ onDone } = {}) {
  const body = el('div');

  body.append(el('p', 'muted',
    'Le modèle de fonds donne les lignes de niveau sur la carte et la sonde dans le moteur de '
    + 'postes. Il se télécharge une fois, gratuitement, et s’installe ici.'));

  /* ---- Où prendre le fichier -------------------------------------------- */
  const how = el('div', 'card');
  how.append(el('div', 'card-head'));
  how.querySelector('.card-head').append(el('h3', null, 'OÙ LE PRENDRE'));
  how.append(el('div', 'list-title', 'SHOM — MNT de façade Atlantique'));
  how.append(el('div', 'list-sub',
    'diffusion.shom.fr → « MNT bathymétrique de façade Atlantique ». Licence ouverte, '
    + 'téléchargement libre, pas de compte à créer. Prends le format .asc.'));
  how.append(el('div', 'tiny',
    'Ce n’est PAS le même chose que la clé de la carte marine : ce fichier-ci fonctionne sans '
    + 'compte et sans réseau une fois installé. EMODnet convient aussi, en GeoTIFF non compressé.'));
  body.append(how);

  /* ---- L'état actuel ----------------------------------------------------- */
  const cur = bathy.meta();
  if (cur) {
    const has = el('div', 'banner info');
    has.append(el('span', null,
      `Un modèle est déjà installé : ${cur.source || 'source inconnue'}, maille ${cur.resolutionM} m. `
      + 'En importer un autre le remplacera.'));
    body.append(has);
  }

  /* ---- Le choix du fichier ----------------------------------------------- */
  const input = document.createElement('input');
  input.type = 'file';
  // `.grd` et `.txt` : certains portails renomment l'ASCII Grid. On ne filtre
  // pas plus serré, quitte à refuser proprement après lecture — un filtre trop
  // strict cache le fichier voulu dans le sélecteur du téléphone.
  input.accept = '.asc,.txt,.grd,.tif,.tiff';
  input.style.display = 'none';
  body.append(input);

  const progress = el('div', 'mnt-prog');
  progress.hidden = true;
  const bar = el('div', 'mnt-bar');
  const barIn = el('div', 'mnt-bar-in');
  bar.append(barIn);
  const pTxt = el('div', 'tiny');
  progress.append(pTxt, bar);
  body.append(progress);

  const pick = button('📂 Choisir le fichier téléchargé', 'btn-primary btn-lg', () => input.click());
  pick.style.marginTop = '10px';
  body.append(pick);

  const note = el('div', 'tiny');
  body.append(note);

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    pick.disabled = true;
    progress.hidden = false;
    note.className = 'tiny';
    note.textContent = '';

    try {
      const spec = await reduce(file, (pct, msg) => {
        barIn.style.width = `${Math.round(pct * 100)}%`;
        pTxt.textContent = msg;
      });
      await idb.put('kv', 'bathyGrid', spec);
      await bathy.reload();
      closeSheet();
      toast(`Modèle installé — maille ${spec.resolutionM} m`, 'good', 4000);
      emit('bathy:changed', spec);
      onDone?.(spec);
    } catch (e) {
      progress.hidden = true;
      pick.disabled = false;
      note.className = 'tiny c-red';
      note.textContent = e?.message || 'Fichier illisible.';
    }
  });

  if (cur) {
    const wipe = button('Retirer le modèle installé', 'btn-sm', async () => {
      await idb.del('kv', 'bathyGrid');
      await bathy.reload();
      closeSheet();
      toast('Modèle retiré');
      emit('bathy:changed', null);
      onDone?.(null);
    });
    wipe.style.marginTop = '10px';
    body.append(wipe);
  }

  return openSheet('Modèle de fonds', body);
}

/* ==========================================================================
 * La réduction, en flux
 * ========================================================================== */

/**
 * @param {File} file
 * @param {(pct:number, msg:string)=>void} onProgress
 * @returns {Promise<object>} La grille, au format lu par js/data/bathy.js.
 */
export async function reduce(file, onProgress = () => {}) {
  const name = (file.name || '').toLowerCase();
  if (/\.tiff?$/.test(name)) {
    throw new Error('GeoTIFF non géré dans l’app — reprends le fichier en .asc sur le portail du SHOM.');
  }

  const rows = Math.floor((NORTH - SOUTH) / TARGET_D);
  const cols = Math.floor((EAST - WEST) / TARGET_D);
  const sum = new Float64Array(rows * cols);
  const cnt = new Uint32Array(rows * cols);

  const stream = file.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();

  let head = null;          // en-tête ASCII Grid
  let buf = '';             // reste de morceau non consommé
  let idx = 0;              // index de la valeur courante dans le raster
  let read = 0;             // octets lus, pour la barre
  let lastTick = 0;

  const total = file.size || 1;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.length;
    buf += value;

    if (!head) {
      // L'en-tête tient dans les premiers centaines d'octets. On attend d'en
      // avoir assez plutôt que de deviner sur un morceau tronqué.
      if (buf.length < 400 && !/\n\s*-?\d/.test(buf)) continue;
      head = parseHeader(buf);
      buf = buf.slice(head.offset);
      validateHeader(head);
      onProgress(0, `${head.ncols} × ${head.nrows} cases, maille ${head.dx.toFixed(5)}°`);
    }

    /* On ne consomme que jusqu'au dernier séparateur : le morceau suivant peut
     * couper un nombre en deux, et « -12.3 » lu comme « -12 » puis « .3 »
     * fabriquerait deux profondeurs fausses au lieu d'une juste. */
    const cut = Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('\n'));
    if (cut < 0) continue;
    const chunk = buf.slice(0, cut);
    buf = buf.slice(cut + 1);

    idx = consume(chunk, head, idx, sum, cnt, rows, cols);

    const now = Date.now();
    if (now - lastTick > 120) {
      lastTick = now;
      onProgress(read / total, `Lecture… ${Math.round((read / total) * 100)} %`);
    }
  }

  // Le reliquat.
  if (head && buf.trim()) idx = consume(buf, head, idx, sum, cnt, rows, cols);
  if (!head) throw new Error('Fichier vide ou en-tête ASCII Grid introuvable.');

  onProgress(1, 'Assemblage…');
  return assemble(sum, cnt, rows, cols, file.name);
}

/* --------------------------------------------------------------------------
 * En-tête
 * ------------------------------------------------------------------------ */
function parseHeader(text) {
  const keys = ['ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter',
    'yllcenter', 'cellsize', 'dx', 'dy', 'nodata_value'];
  const h = {};
  let offset = 0;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const k = (parts[0] || '').toLowerCase();
    if (!keys.includes(k)) break;
    h[k] = Number(parts[1]);
    offset += line.length + 1;
  }
  const dx = h.cellsize ?? h.dx;
  const dy = h.cellsize ?? h.dy ?? dx;
  let x0 = h.xllcorner ?? h.xllcenter;
  let y0 = h.yllcorner ?? h.yllcenter;
  if (h.xllcenter != null) { x0 -= dx / 2; y0 -= dy / 2; }
  return {
    ncols: h.ncols, nrows: h.nrows, dx, dy, x0, y0,
    nodata: h.nodata_value ?? -9999,
    offset,
  };
}

function validateHeader(h) {
  if (!h.ncols || !h.nrows || !h.dx) {
    throw new Error('Ce n’est pas un ASCII Grid : en-tête ncols/nrows/cellsize absent.');
  }
  /* Le seuil est à 0,002°, soit environ 220 m, et il est choisi pour laisser
   * passer les deux sources utiles en écartant la troisième :
   *   SHOM façade      0,001°   ≈ 111 m   ✓
   *   EMODnet DTM      0,00104° ≈ 115 m   ✓
   *   GEBCO mondial    0,00417° ≈ 460 m   ✗
   * GEBCO passait sous l'ancien seuil de 0,02°. Il aurait produit une grille
   * de 334 m RÉÉCHANTILLONNÉE depuis 460 — c'est-à-dire une carte qui affiche
   * plus de détail qu'elle n'en contient, exactement ce qu'on refuse partout
   * ailleurs dans cette app. */
  if (h.dx > 0.002) {
    const m = Math.round(h.dx * 111320);
    throw new Error(`Maille de ${m} m — trop grossière pour du côtier. `
      + (m > 300 ? 'C’est la grille mondiale GEBCO : elle ne montre rien sous 40 m d’eau. '
        : '')
      + 'Prends le MNT de façade Atlantique du SHOM (111 m) sur diffusion.shom.fr.');
  }
  // L'emprise doit intersecter la nôtre, sinon on lit trois cents mégaoctets
  // pour rien et on rend une grille vide sans expliquer pourquoi.
  const n = h.y0 + h.nrows * h.dy;
  const e = h.x0 + h.ncols * h.dx;
  if (n < SOUTH || h.y0 > NORTH || e < WEST || h.x0 > EAST) {
    throw new Error('Ce fichier ne couvre pas le secteur de l’app '
      + `(${SOUTH}–${NORTH}° N, ${WEST}–${EAST}° E). Redemande la dalle qui contient Dieppe.`);
  }
}

/* --------------------------------------------------------------------------
 * Consommation d'un morceau
 * ------------------------------------------------------------------------ */
function consume(chunk, h, idx, sum, cnt, rows, cols) {
  // `split` sur une expression régulière est deux fois plus lent qu'un
  // parcours manuel sur des fichiers de cette taille. On reste simple : les
  // séparateurs d'un ASCII Grid sont l'espace et le saut de ligne.
  let i = 0;
  const len = chunk.length;
  while (i < len) {
    while (i < len && (chunk.charCodeAt(i) === 32 || chunk.charCodeAt(i) === 10
      || chunk.charCodeAt(i) === 13 || chunk.charCodeAt(i) === 9)) i++;
    if (i >= len) break;
    let j = i;
    while (j < len && chunk.charCodeAt(j) > 32) j++;
    const v = Number(chunk.slice(i, j));
    i = j;

    const si = Math.floor(idx / h.ncols);   // ligne source, 0 = NORD
    const sj = idx - si * h.ncols;
    idx++;
    if (!Number.isFinite(v) || v === h.nodata) continue;

    // Position géographique du centre de la case source.
    const lat = h.y0 + h.nrows * h.dy - (si + 0.5) * h.dy;
    const lon = h.x0 + (sj + 0.5) * h.dx;
    if (lat < SOUTH || lat >= NORTH || lon < WEST || lon >= EAST) continue;

    // Ligne 0 = LE SUD : c'est la convention du décodeur embarqué.
    const ti = Math.floor((lat - SOUTH) / TARGET_D);
    const tj = Math.floor((lon - WEST) / TARGET_D);
    if (ti < 0 || ti >= rows || tj < 0 || tj >= cols) continue;
    const k = ti * cols + tj;
    sum[k] += v;
    cnt[k] += 1;
  }
  return idx;
}

/* --------------------------------------------------------------------------
 * Assemblage et garde-fous
 * ------------------------------------------------------------------------ */
function assemble(sum, cnt, rows, cols, sourceName) {
  const cells = new Array(rows * cols);
  let positives = 0;
  let water = 0;

  for (let k = 0; k < cells.length; k++) {
    if (!cnt[k]) { cells[k] = NODATA; continue; }
    // Convention des MNT : l'altitude est positive vers le haut, la mer est
    // donc négative, et la profondeur son opposé.
    const depth = -(sum[k] / cnt[k]);
    if (depth < 0) positives++;
    water++;
    cells[k] = Math.round(depth);
  }
  if (!water) {
    throw new Error('Aucune donnée dans le secteur de l’app. Mauvaise dalle ?');
  }

  // Fichier déjà livré en profondeurs positives : on retourne tout.
  if (positives > 0.7 * water) {
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] !== NODATA) cells[k] = -cells[k];
    }
  }
  // La terre est marquée, pas rendue comme une profondeur négative.
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] !== NODATA && cells[k] <= 0) cells[k] = LAND;
  }

  const sea = cells.filter((c) => c !== LAND && c !== NODATA);
  if (!sea.length) throw new Error('Aucune cellule de mer dans le secteur.');

  // Vraisemblance : le coin nord-ouest est au large de Fécamp.
  const nw = cells[Math.floor(rows * 0.95) * cols + Math.floor(cols * 0.05)];
  if (nw === LAND || nw === NODATA || nw < SANITY_MIN || nw > SANITY_MAX) {
    throw new Error(`Le coin nord-ouest annonce ${nw === LAND ? 'de la terre' : `${nw} m`}. `
      + `Il est à 30 milles au large de Fécamp, donc entre ${SANITY_MIN} et ${SANITY_MAX} m. `
      + 'Ce fichier n’est pas un modèle de profondeurs — un rendu colorié, peut-être.');
  }

  sea.sort((a, b) => a - b);
  return {
    size: [rows, cols],
    grid: encode(cells),
    bbox: [SOUTH, WEST, NORTH, EAST],
    step: [TARGET_D, TARGET_D],
    source: sourceName || 'importé',
    coverage: 'MNT bathymétrique agrégé',
    licence: 'Licence ouverte / CC-BY selon la source',
    fetchedAt: new Date().toISOString(),
    resolutionM: Math.round(TARGET_D * 111320),
    depthRangeM: [sea[0], sea[sea.length - 1]],
    note: 'Modèle public agrégé. À cette maille on lit le plateau, sa cassure, les fosses '
      + 'et les grands bancs — pas le ridin isolé. Le sondeur du bord reste le juge.',
  };
}

/**
 * Miroir exact de decode() dans js/data/bathy.js : liste PLATE de couples
 * (différence, répétitions), le décodeur appliquant `prev += d` à CHAQUE
 * répétition. Les sentinelles échappent à la chaîne sans toucher `prev`.
 */
function encode(cells) {
  const out = [];
  let prev = 0;
  let i = 0;
  const n = cells.length;
  while (i < n) {
    const c = cells[i];
    if (c === LAND || c === NODATA) {
      let run = 1;
      while (i + run < n && cells[i + run] === c) run++;
      out.push(c, run);
      i += run;
      continue;
    }
    const d = c - prev;
    prev = c;
    let run = 1;
    while (i + run < n && cells[i + run] !== LAND && cells[i + run] !== NODATA
      && cells[i + run] - prev === d) {
      prev = cells[i + run];
      run++;
    }
    out.push(d, run);
    i += run;
  }
  return out;
}

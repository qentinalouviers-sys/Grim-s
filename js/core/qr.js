/* ==========================================================================
 * core/qr.js — encodeur QR, à bord
 * --------------------------------------------------------------------------
 * Pourquoi écrire un encodeur QR au lieu d'appeler un service qui en génère :
 * parce que le moment où l'on veut passer l'app au bateau d'à côté est
 * exactement celui où l'on est à six milles du bord, sans réseau, moteur au
 * ralenti, bord à bord. Un QR qui a besoin d'internet pour s'afficher ne sert
 * à rien précisément là où il servirait.
 *
 * Implémentation conforme ISO/IEC 18004, réduite à ce dont on a besoin :
 * mode OCTET, versions 1 à 10, quatre niveaux de correction. Une URL
 * d'application tient en version 3 à 5 ; la marge jusqu'à 10 couvre un
 * hébergement au nom plus long.
 *
 * Les quatre étapes, dans l'ordre :
 *   1. encodage    mode + longueur + octets + remplissage
 *   2. correction  Reed-Solomon sur GF(256), par blocs, puis entrelacement
 *   3. matrice     motifs de repérage, synchronisation, alignement, données
 *   4. masque      les huit masques sont calculés, on garde le moins pénalisé
 *
 * L'étape 4 n'est pas cosmétique : un masque mal choisi produit des plages
 * uniformes que les lecteurs confondent avec les motifs de repérage. On paie
 * huit constructions de matrice pour un code qui se lit du premier coup, sur
 * un écran mouillé, à bout de bras.
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * Corps de Galois GF(256), polynôme primitif 0x11D
 * ------------------------------------------------------------------------ */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Polynôme générateur de degré n : (x−α⁰)(x−α¹)…(x−αⁿ⁻¹).
 *
 * La multiplication ci-dessous produit les coefficients par degré CROISSANT —
 * `next[j + 1] ^= poly[j]` est la multiplication par x, elle pousse vers les
 * indices hauts. La division synthétique de ecBlock(), elle, attend le
 * coefficient dominant en tête. D'où le renversement final : sans lui les
 * mots de correction sont calculés avec le polynôme à l'envers, la matrice
 * reste parfaitement formée, et aucun lecteur ne décode — la correction
 * d'erreurs rejette tout. C'est le second défaut qu'a trouvé la relecture.
 */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

/** Mots de correction d'un bloc de données. */
function ecBlock(data, ecCount) {
  const gen = generator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) rem[i] ^= mul(gen[i + 1], factor);
    }
  }
  return rem;
}

/* --------------------------------------------------------------------------
 * Tables de structure
 * --------------------------------------------------------------------------
 * Par version et niveau : [mots de correction par bloc, blocs du groupe 1,
 * données par bloc du groupe 1, blocs du groupe 2, données par bloc du
 * groupe 2]. Vérifiées par la somme : ec×blocs + données = capacité totale
 * de la version. Le contrôle est fait au chargement, plus bas.
 * ------------------------------------------------------------------------ */
export const EC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const BLOCKS = {
  1: { L: [7, 1, 19], M: [10, 1, 16], Q: [13, 1, 13], H: [17, 1, 9] },
  2: { L: [10, 1, 34], M: [16, 1, 28], Q: [22, 1, 22], H: [28, 1, 16] },
  3: { L: [15, 1, 55], M: [26, 1, 44], Q: [18, 2, 17], H: [22, 2, 13] },
  4: { L: [20, 1, 80], M: [18, 2, 32], Q: [26, 2, 24], H: [16, 4, 9] },
  5: { L: [26, 1, 108], M: [24, 2, 43], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68], M: [16, 4, 27], Q: [24, 4, 19], H: [28, 4, 15] },
  7: { L: [20, 2, 78], M: [18, 4, 31], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
};

/** Capacité totale en mots, par version. */
const TOTAL = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };

/** Centres des motifs d'alignement. */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* Garde-fou de table : une ligne fausse produirait des QR illisibles de façon
   subtile — lisibles par certains lecteurs, pas par d'autres. Autant le savoir
   au chargement du module qu'au milieu de la Manche. */
for (const [v, levels] of Object.entries(BLOCKS)) {
  for (const [lvl, row] of Object.entries(levels)) {
    const [ec, b1, d1, b2 = 0, d2 = 0] = row;
    const sum = ec * (b1 + b2) + d1 * b1 + d2 * b2;
    if (sum !== TOTAL[v]) {
      throw new Error(`[qr] table incohérente v${v}${lvl} : ${sum} ≠ ${TOTAL[v]}`);
    }
  }
}

const dataCapacity = (version, level) => {
  const [ec, b1, d1, b2 = 0, d2 = 0] = BLOCKS[version][level];
  return d1 * b1 + d2 * b2;
};

/**
 * Structure des blocs, exposée pour le contrôle de cohérence : il relit la
 * matrice produite, et pour dés-entrelacer il lui faut exactement ce
 * découpage. Le lui faire recopier reviendrait à comparer une table à
 * elle-même.
 * @returns {{ecPerBlock:number, blocks:number[]}} taille de chaque bloc de données
 */
export function blockStructure(version, level) {
  const [ec, b1, d1, b2 = 0, d2 = 0] = BLOCKS[version][level];
  return {
    ecPerBlock: ec,
    blocks: [...new Array(b1).fill(d1), ...new Array(b2).fill(d2)],
  };
}

/* --------------------------------------------------------------------------
 * Encodage
 * ------------------------------------------------------------------------ */
class BitBuffer {
  constructor() {
    this.bits = [];
  }

  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }

  get length() {
    return this.bits.length;
  }

  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/**
 * Encode un texte en matrice de modules.
 * @param {string} text
 * @param {{level?:'L'|'M'|'Q'|'H', minVersion?:number}} [opts]
 * @returns {{size:number, modules:Uint8Array, version:number, level:string}}
 *   modules[y * size + x] vaut 1 (sombre) ou 0 (clair).
 */
export function encode(text, opts = {}) {
  const level = opts.level || 'M';
  const bytes = new TextEncoder().encode(text);

  let version = Math.max(1, opts.minVersion || 1);
  while (version <= 10) {
    const countBits = version < 10 ? 8 : 16;
    const needed = 4 + countBits + bytes.length * 8;
    if (needed <= dataCapacity(version, level) * 8) break;
    version++;
  }
  if (version > 10) throw new Error('[qr] contenu trop long pour la version 10');

  const countBits = version < 10 ? 8 : 16;
  const buf = new BitBuffer();
  buf.put(0b0100, 4);              // mode octet
  buf.put(bytes.length, countBits);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = dataCapacity(version, level) * 8;
  buf.put(0, Math.min(4, capacityBits - buf.length)); // terminateur
  while (buf.length % 8) buf.bits.push(0);
  const data = Array.from(buf.toBytes());
  // Remplissage alterné, imposé par la norme.
  for (let i = 0; data.length < dataCapacity(version, level); i++) {
    data.push(i % 2 === 0 ? 0xec : 0x11);
  }

  /* --- Découpage en blocs, correction, entrelacement -------------------- */
  const [ecCount, b1, d1, b2 = 0, d2 = 0] = BLOCKS[version][level];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) {
    blocks.push(data.slice(offset, offset + d1));
    offset += d1;
  }
  for (let i = 0; i < b2; i++) {
    blocks.push(data.slice(offset, offset + d2));
    offset += d2;
  }
  const ecs = blocks.map((b) => ecBlock(b, ecCount));

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const e of ecs) out.push(e[i]);
  }

  return buildMatrix(out, version, level);
}

/* --------------------------------------------------------------------------
 * Matrice
 * ------------------------------------------------------------------------ */
function buildMatrix(codewords, version, level) {
  const size = 17 + 4 * version;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const at = (x, y) => y * size + x;

  const setFn = (x, y, v) => {
    modules[at(x, y)] = v;
    reserved[at(x, y)] = 1;
  };

  /* --- Motifs de repérage et séparateurs -------------------------------- */
  const finder = (ox, oy) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
          && (dx === 0 || dx === 6 || dy === 0 || dy === 6
            || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFn(x, y, inRing ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  /* --- Synchronisation --------------------------------------------------- */
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setFn(i, 6, v);
    setFn(6, i, v);
  }

  /* --- Alignement -------------------------------------------------------- */
  const centers = ALIGN[version];
  for (const cy of centers) {
    for (const cx of centers) {
      // Les trois coins portent déjà un motif de repérage.
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  /* --- Module sombre et zones réservées ---------------------------------- */
  setFn(8, size - 8, 1);
  for (let i = 0; i < 9; i++) {
    if (!reserved[at(i, 8)]) reserved[at(i, 8)] = 1;
    if (!reserved[at(8, i)]) reserved[at(8, i)] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[at(size - 1 - i, 8)] = 1;
    reserved[at(8, size - 1 - i)] = 1;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[at(i, size - 11 + j)] = 1;
        reserved[at(size - 11 + j, i)] = 1;
      }
    }
  }

  /* --- Données, en zigzag depuis le coin bas-droit ----------------------- */
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // la colonne de synchronisation ne porte pas de données
    for (let row = 0; row < size; row++) {
      const y = upward ? size - 1 - row : row;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (reserved[at(x, y)]) continue;
        const byte = codewords[bitIndex >> 3];
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
        modules[at(x, y)] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }

  /* --- Masques : on les essaie tous et on garde le meilleur -------------- */
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(modules, reserved, size, mask);
    placeFormat(candidate, reserved, size, level, mask);
    if (version >= 7) placeVersion(candidate, size, version);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, modules: candidate, mask };
  }

  return { size, modules: best.modules, version, level, mask: best.mask };
}

function applyMask(modules, reserved, size, mask) {
  const out = Uint8Array.from(modules);
  const rule = MASKS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (reserved[i]) continue;
      if (rule(y, x)) out[i] ^= 1;
    }
  }
  return out;
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** Information de format : BCH(15,5) puis masque fixe 0x5412. */
function placeFormat(modules, reserved, size, level, mask) {
  let bits = (EC_BITS[level] << 3) | mask;
  let rem = bits;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const format = ((bits << 10) | rem) ^ 0x5412;

  /* Placement, et c'est ici que se joue la lisibilité du code.
   *
   * Autour du repère haut-gauche, les bits de poids faible descendent la
   * COLONNE 8 et les bits de poids fort remontent la LIGNE 8. La seconde copie
   * fait l'inverse : poids faibles sur la ligne 8 à droite, poids forts sur la
   * colonne 8 en bas. Écrire les deux dans l'autre sens produit une matrice
   * d'apparence parfaite — repères, synchronisation, données, tout est en
   * place — que pas un lecteur au monde ne décode, parce qu'il ne trouve même
   * pas le niveau de correction. C'est le défaut qu'a attrapé le contrôle par
   * relecture, et il ne se voit pas à l'œil. */
  const bit = (i) => (format >> i) & 1;
  const set = (row, col, v) => { modules[row * size + col] = v; };

  for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i <= 14; i++) set(8, 14 - i, bit(i));

  for (let i = 0; i <= 7; i++) set(8, size - 1 - i, bit(i));
  for (let i = 8; i <= 14; i++) set(size - 15 + i, 8, bit(i));
  set(size - 8, 8, 1); // module sombre, permanent
}

/** Information de version, versions 7 et au-delà : BCH(18,6). */
function placeVersion(modules, size, version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  const info = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = (info >> i) & 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    modules[b * size + a] = bit;
    modules[a * size + b] = bit;
  }
}

/* --------------------------------------------------------------------------
 * Pénalités — les quatre règles de la norme
 * ------------------------------------------------------------------------ */
function penalty(m, size) {
  const at = (x, y) => m[y * size + x];
  let score = 0;

  // 1. Séries de cinq modules ou plus de même couleur.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = horizontal ? at(j, i) : at(i, j);
        const prev = horizontal ? at(j - 1, i) : at(i, j - 1);
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // 2. Blocs 2×2 uniformes.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }

  // 3. Motif 1:1:3:1:1 entouré de clair — la signature du repère, à éviter
  //    ailleurs que dans les vrais repères.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const REVERSE = [...PATTERN].reverse();
  const matches = (get, start) => {
    for (const pat of [PATTERN, REVERSE]) {
      let ok = true;
      for (let k = 0; k < pat.length; k++) {
        if (get(start + k) !== pat[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matches((k) => at(k, i), j)) score += 40;
      if (matches((k) => at(i, k), j)) score += 40;
    }
  }

  // 4. Déséquilibre entre modules sombres et clairs.
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

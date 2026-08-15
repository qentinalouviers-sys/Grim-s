/* ==========================================================================
 * fishing/lures.js — choix du leurre : couleur, silhouette, plombée
 * --------------------------------------------------------------------------
 * Le bar est l'espèce n°1 du secteur, et la question qui revient le plus dans
 * un bateau n'est pas « où » mais « je mets quoi ». Les tableaux de couleurs
 * qui circulent — « eau sale = chartreuse, eau claire = naturel » — ont raison
 * dans les grandes lignes et ne disent jamais POURQUOI, donc ne savent pas
 * quoi faire des cas mixtes : eau laiteuse mais grand soleil, eau claire mais
 * nuit noire, 35 m de fond sous un ciel de plomb.
 *
 * Ici on raisonne sur deux axes physiques, et la couleur en découle.
 *
 * ── AXE 1 : COMBIEN DE LUMIÈRE ARRIVE, ET DE QUELLE COULEUR ──────────────
 * L'eau absorbe d'abord les grandes longueurs d'onde. Le rouge est éteint en
 * quelques mètres, l'orange ensuite, le jaune après. Dans une eau côtière
 * chargée comme la Manche — craie en suspension, sable remué par la houle —
 * la fenêtre de transmission se déplace vers le JAUNE-VERT, autour de
 * 550-580 nm. C'est exactement là qu'émet le chartreuse fluorescent : il
 * absorbe le bleu et l'ultraviolet et les réémet dans la seule bande qui passe
 * encore. Ce n'est pas une superstition de pêcheur, c'est de la photométrie —
 * et ça explique pourquoi le rose fluo, qui réémet plus haut en longueur
 * d'onde, perd du terrain dès qu'on descend.
 *
 * ── AXE 2 : CONTRE QUOI LE POISSON REGARDE ───────────────────────────────
 * Un bar en chasse regarde majoritairement VERS LE HAUT : sa proie se découpe
 * sur la surface éclairée. Dans ce cas ce n'est pas la couleur qui porte,
 * c'est la SILHOUETTE — et la silhouette la plus lisible sur un fond clair est
 * noire. À l'inverse, quand il fouille au ras du fond, dans une eau où la
 * lumière vient de partout et de nulle part, c'est le leurre qui doit émettre :
 * flash, nacre, fluo.
 *
 * D'où la règle qui sort du modèle et que peu de tableaux formulent :
 *   leurre de surface à l'aube = NOIR, pas blanc.
 *   shad à 30 m dans l'eau de craie = chartreuse ou blanc nacré, pas naturel.
 *
 * ── CE QUE LE MODÈLE NE PRÉTEND PAS ──────────────────────────────────────
 * Aucune couleur ne rattrape une mauvaise animation ni un poste mort. Le
 * modèle propose trois couleurs classées, pas une vérité : le premier choix
 * est celui qui a le plus de chances d'être vu, les suivants sont là parce que
 * le bar refuse parfois ce qu'il voit le mieux.
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * 1. États du ciel — ce qui entre dans l'eau
 * ------------------------------------------------------------------------ */
export const SKIES = [
  {
    id: 'soleil',
    name: 'Grand soleil',
    emoji: '☀️',
    swatch: '#4aa8ff',
    // Lumière forte et directionnelle : le poisson voit loin et voit juste.
    light: 1,        // quantité de lumière qui pénètre
    contrast: 1,     // netteté du contre-jour vers la surface
  },
  { id: 'voile', name: 'Ciel voilé', emoji: '🌤️', swatch: '#a8c8e8', light: 0.8, contrast: 0.7 },
  { id: 'couvert', name: 'Couvert', emoji: '☁️', swatch: '#9aa8b8', light: 0.5, contrast: 0.45 },
  { id: 'plomb', name: 'Ciel de plomb', emoji: '🌧️', swatch: '#5d6b7a', light: 0.28, contrast: 0.3 },
  { id: 'aube', name: 'Aube / crépuscule', emoji: '🌅', swatch: '#e8845a', light: 0.2, contrast: 0.95 },
  { id: 'nuit', name: 'Nuit', emoji: '🌙', swatch: '#131c2b', light: 0.04, contrast: 0.75 },
];

/* --------------------------------------------------------------------------
 * 2. Couleurs d'eau — ce qui reste de cette lumière à un mètre
 * --------------------------------------------------------------------------
 * `clarity` : distance de visibilité relative, 1 = on voit loin.
 * `shift`   : déplacement de la fenêtre de transmission vers le jaune-vert.
 *             0 = eau bleue océanique, 1 = eau de craie ou de crue.
 * ------------------------------------------------------------------------ */
export const WATERS = [
  {
    id: 'claire',
    name: 'Claire, bleu-vert',
    emoji: '💎',
    swatch: '#1f8fa8',
    hint: 'on voit le plomb à deux brasses',
    clarity: 1,
    shift: 0.15,
  },
  {
    id: 'verte',
    name: 'Verte',
    emoji: '🟢',
    swatch: '#2f7d5e',
    hint: 'la teinte normale du secteur',
    clarity: 0.7,
    shift: 0.45,
  },
  {
    // La signature du pays de Caux : falaise de craie + houle = lait.
    id: 'craie',
    name: 'Laiteuse (craie)',
    emoji: '🥛',
    swatch: '#9fb6bd',
    hint: 'après un coup de vent sur la falaise',
    clarity: 0.4,
    shift: 0.8,
  },
  {
    id: 'terreuse',
    name: 'Marron, terreuse',
    emoji: '🟤',
    swatch: '#7a6244',
    hint: 'sortie de fleuve, gros coefficient',
    clarity: 0.22,
    shift: 1,
  },
  {
    id: 'brassee',
    name: 'Brassée, écumeuse',
    emoji: '🌊',
    swatch: '#5d7c8a',
    hint: 'dans le déferlement ou la veine',
    clarity: 0.35,
    shift: 0.7,
  },
];

/* --------------------------------------------------------------------------
 * 3. Palette
 * --------------------------------------------------------------------------
 * Chaque coloris est noté sur quatre qualités indépendantes, entre 0 et 1 :
 *
 *   reach       portée dans une eau chargée — combien de mètres avant de
 *               disparaître. Le fluo jaune-vert gagne, le rouge perd.
 *   natural     crédibilité de proie quand le poisson voit bien et a le temps
 *               de détailler.
 *   silhouette  lisibilité en contre-jour, vu d'en dessous. Le noir gagne.
 *   flash       renvoi de lumière ponctuel, qui déclenche l'attaque réflexe.
 * ------------------------------------------------------------------------ */
export const COLOURS = [
  {
    id: 'lancon',
    name: 'Naturel lançon',
    hex: '#8fa9b8',
    hex2: '#e9f1f5',
    note: 'dos vert-bleu, flanc translucide, ventre nacré',
    reach: 0.3, natural: 1, silhouette: 0.35, flash: 0.5,
  },
  {
    id: 'ayu',
    name: 'Ayu / sardine',
    hex: '#4d7f8c',
    hex2: '#dfe9ec',
    note: 'le passe-partout quand l’eau est belle',
    reach: 0.35, natural: 0.95, silhouette: 0.4, flash: 0.55,
  },
  {
    id: 'blanc',
    name: 'Blanc nacré',
    hex: '#eef3f6',
    hex2: '#ffffff',
    note: 'la valeur sûre en eau teintée, de jour comme de nuit',
    reach: 0.75, natural: 0.6, silhouette: 0.25, flash: 0.85,
  },
  {
    id: 'chartreuse',
    name: 'Chartreuse fluo',
    hex: '#c7f52e',
    hex2: '#eaff8a',
    note: 'réémet à 550 nm — la seule bande qui passe dans l’eau de craie',
    reach: 1, natural: 0.2, silhouette: 0.3, flash: 0.7,
  },
  {
    id: 'rose',
    name: 'Rose fluo',
    hex: '#ff5f9e',
    hex2: '#ffa9c9',
    note: 'très vu près de la surface, s’éteint vite en profondeur',
    reach: 0.7, natural: 0.15, silhouette: 0.35, flash: 0.6,
  },
  {
    id: 'orange',
    name: 'Orange feu',
    hex: '#ff7a1a',
    hex2: '#ffb066',
    note: 'crevette et crabe ; porte peu au-delà de dix mètres',
    reach: 0.45, natural: 0.5, silhouette: 0.4, flash: 0.5,
  },
  {
    id: 'noir',
    name: 'Noir / violet sombre',
    hex: '#14161c',
    hex2: '#2c2440',
    note: 'la silhouette la plus lisible en contre-jour',
    reach: 0.4, natural: 0.55, silhouette: 1, flash: 0.05,
  },
  {
    id: 'kaki',
    name: 'Kaki / motoroil',
    hex: '#5c5a33',
    hex2: '#8a8a52',
    note: 'discret, pour l’eau claire et le poisson méfiant',
    reach: 0.25, natural: 0.9, silhouette: 0.7, flash: 0.15,
  },
  {
    id: 'argent',
    name: 'Bleu dos, flanc argent',
    hex: '#2b5f9e',
    hex2: '#d7dee6',
    note: 'maquereau ; le flash porte loin en plein soleil',
    reach: 0.4, natural: 0.85, silhouette: 0.5, flash: 1,
  },
  {
    id: 'dore',
    name: 'Doré / cuivre',
    hex: '#b8862b',
    hex2: '#e6bc63',
    note: 'flash chaud, efficace dans l’eau verte et à l’étale du soir',
    reach: 0.55, natural: 0.6, silhouette: 0.45, flash: 0.9,
  },
];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const byId = (list, id) => list.find((x) => x.id === id) || null;
export const sky = (id) => byId(SKIES, id);
export const water = (id) => byId(WATERS, id);
export const colour = (id) => byId(COLOURS, id);

/* --------------------------------------------------------------------------
 * 4. Le modèle
 * ------------------------------------------------------------------------ */

/**
 * Ce que le poisson perçoit, à partir du ciel, de l'eau et de la sonde.
 *
 * @param {object} o
 * @param {string} o.skyId
 * @param {string} o.waterId
 * @param {number} [o.depthM]     sonde de pêche, mètres
 * @param {number} [o.currentKn]  courant, nœuds
 */
export function conditions({ skyId, waterId, depthM = 12, currentKn = 1 }) {
  const s = sky(skyId) || SKIES[2];
  const w = water(waterId) || WATERS[1];

  // Lumière restante à la profondeur de pêche. L'atténuation est
  // exponentielle ; le coefficient dépend de la charge de l'eau. Une eau
  // laiteuse éteint tout en quinze mètres, une eau claire en quarante.
  const k = 0.045 + 0.16 * (1 - w.clarity);
  const atDepth = clamp01(s.light * Math.exp(-k * Math.max(0, depthM)));

  // Distance à laquelle le leurre est vu. Sert à décider s'il faut crier.
  const visM = Math.max(0.4, 9 * w.clarity * (0.35 + 0.65 * Math.sqrt(s.light)));

  // Le poisson regarde-t-il vers le haut ? Oui quand la surface est encore
  // lumineuse par rapport au fond — donc en surface, et surtout aux heures
  // rasantes où le contre-jour est maximal.
  const upward = clamp01(s.contrast * Math.exp(-0.09 * Math.max(0, depthM - 2)));

  return {
    sky: s,
    water: w,
    depthM,
    currentKn,
    lightAtDepth: atDepth,
    visibilityM: visM,
    upward,
    shift: w.shift,
    // Faut-il de la portée plutôt que du réalisme ? Deux choses la commandent :
    // l'eau qui masque, et le fond qui éteint.
    loudness: clamp01(0.55 * (1 - w.clarity) + 0.45 * (1 - atDepth)),
  };
}

/** Les couleurs, classées, avec la raison du classement. */
export function rank(cond, { limit = 3 } = {}) {
  const { loudness, upward, shift, lightAtDepth } = cond;

  const scored = COLOURS.map((c) => {
    // Portée : d'autant plus décisive que l'eau masque. Le décalage vers le
    // jaune-vert avantage les fluo de cette bande, pas les autres.
    const reach = c.reach * (0.6 + 0.4 * shift * (c.id === 'chartreuse' ? 1.25 : 1));
    const parts = [
      { key: 'portee', label: 'portée dans cette eau', v: reach, w: 1.6 * loudness },
      { key: 'naturel', label: 'crédibilité de proie', v: c.natural, w: 1.5 * (1 - loudness) },
      { key: 'silhouette', label: 'silhouette en contre-jour', v: c.silhouette, w: 1.7 * upward },
      // Le flash ne sert que s'il reste de la lumière à réfléchir : de nuit à
      // vingt mètres, une paillette d'argent est un morceau de plastique gris.
      { key: 'flash', label: 'flash', v: c.flash, w: 1.1 * lightAtDepth * (0.4 + 0.6 * (1 - upward)) },
    ];
    const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
    const score = parts.reduce((a, p) => a + p.v * p.w, 0) / wsum;
    const driver = parts.slice().sort((a, b) => b.v * b.w - a.v * a.w)[0];
    return { colour: c, score, parts, driver };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s, i) => ({
    ...s,
    rank: i + 1,
    score100: Math.round(s.score * 100),
  }));
}

/* --------------------------------------------------------------------------
 * 5. Ce qu'on accroche au bout
 * ------------------------------------------------------------------------ */

/**
 * Plombée : assez lourde pour toucher le fond, assez légère pour que le shad
 * travaille. La règle du bord — « un gramme par mètre » — ne tient qu'à
 * courant nul ; en Manche orientale, à deux nœuds de dérive, il faut le
 * double. On l'arrondit aux tailles qui existent réellement en boîte.
 */
const JIG_SIZES = [5, 7, 10, 14, 18, 21, 28, 35, 40, 50, 60, 80, 100, 120, 150];

export function rigWeight(depthM = 12, currentKn = 1) {
  const raw = Math.max(3, depthM * (0.8 + 0.9 * Math.max(0, currentKn)));
  let best = JIG_SIZES[0];
  for (const s of JIG_SIZES) if (Math.abs(s - raw) < Math.abs(best - raw)) best = s;
  const i = JIG_SIZES.indexOf(best);
  return { grams: best, alt: JIG_SIZES[Math.min(JIG_SIZES.length - 1, i + 1)], raw: Math.round(raw) };
}

/** Famille de leurre à privilégier, avec la raison. */
export function family(cond) {
  const { depthM, upward, water: w, sky: s, currentKn } = cond;
  if (depthM <= 4 && upward > 0.6) {
    return {
      id: 'surface',
      name: 'Leurre de surface',
      why: 'Le poisson chasse en levant les yeux : le bruit et la silhouette font tout, la couleur presque rien.',
    };
  }
  if (w.clarity < 0.45) {
    return {
      id: 'vibration',
      name: 'Shad à forte caudale, ou lame vibrante',
      why: `Visibilité de l’ordre de ${cond.visibilityM.toFixed(1)} m : le bar trouvera le leurre à la ligne latérale avant de le voir. Il faut du déplacement d’eau.`,
    };
  }
  if (depthM >= 25 || currentKn >= 2) {
    return {
      id: 'jig',
      name: 'Shad plombé lourd ou jig',
      why: 'Sonde et courant : la priorité est de tenir le fond sans que la bannière parte à l’horizontale.',
    };
  }
  if (s.light < 0.25) {
    return {
      id: 'slug',
      name: 'Slug ou shad à nage ample',
      why: 'Peu de lumière : une nage lente et lisible vaut mieux qu’une vibration rapide que le poisson rate.',
    };
  }
  return {
    id: 'shad',
    name: 'Shad 12–15 cm sur tête plombée',
    why: 'Conditions moyennes : le montage qui pardonne le plus, du bord de ridin à l’épave.',
  };
}

/** Le paragraphe qu'on lit à voix haute dans le bateau. */
export function verdict(cond, top) {
  const { water: w, sky: s, upward, visibilityM, lightAtDepth } = cond;
  const first = top[0]?.colour;
  if (!first) return '';
  if (upward > 0.6) {
    return `Contre-jour marqué : à ${cond.depthM} m sous un ${s.name.toLowerCase()}, le bar voit ta proie en ombre chinoise sur la surface. C’est la silhouette qui décide, pas la teinte — d’où ${first.name.toLowerCase()}.`;
  }
  if (w.clarity < 0.45) {
    return `Eau chargée : environ ${visibilityM.toFixed(1)} m de visibilité, et la fenêtre de couleur qui passe encore s’est refermée sur le jaune-vert. ${first.name} est ce qui reste lisible le plus loin.`;
  }
  if (lightAtDepth < 0.12) {
    return `Il ne reste presque plus de lumière à ${cond.depthM} m : les paillettes ne renvoient plus rien. ${first.name} joue sur le contraste, pas sur le reflet.`;
  }
  return `Eau ${w.name.toLowerCase()} et ${s.name.toLowerCase()} : le bar a le temps de détailler. On reste crédible — ${first.name.toLowerCase()} — et on garde une couleur voyante en second choix si ça ne mord pas dans le quart d’heure.`;
}

/* --------------------------------------------------------------------------
 * 6. Lecture d'une photo
 * --------------------------------------------------------------------------
 * Décrire une couleur d'eau avec des mots est un exercice où deux pêcheurs ne
 * tombent jamais d'accord. L'appareil photo, lui, mesure. On échantillonne le
 * centre de l'image, on convertit en teinte / saturation / clarté, et on
 * rapproche du profil le plus proche.
 *
 * Le blanc de la craie est la clé du secteur : très clair, très peu saturé.
 * C'est précisément ce qu'un œil humain appelle « pas très sale » alors que la
 * visibilité y est de moins d'un mètre.
 * ------------------------------------------------------------------------ */

/** Moyenne du carré central d'un canvas → { r, g, b, h, s, l }. */
export function sampleCanvas(canvas, frac = 0.4) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;
  const sw = Math.max(1, Math.round(w * frac));
  const sh = Math.max(1, Math.round(h * frac));
  const data = ctx.getImageData(Math.round((w - sw) / 2), Math.round((h - sh) / 2), sw, sh).data;
  let r = 0, g = 0, b = 0, n = 0;
  // Un pixel sur seize suffit pour une moyenne, et reste fluide sur un vieux
  // téléphone : on n'a pas besoin de lire deux millions de pixels pour savoir
  // que l'eau est verte.
  for (let i = 0; i < data.length; i += 64) {
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), ...rgbToHsl(r, g, b) };
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

/** Couleur d'eau la plus proche d'un échantillon, avec un indice de confiance. */
export function classifyWater({ h, s, l }) {
  const scores = WATERS.map((w) => {
    let v;
    switch (w.id) {
      // Bleu-vert franc, moyennement clair : on voit le fond.
      case 'claire':
        v = near(h, 190, 45) * (0.4 + 0.6 * near(s, 0.42, 0.35)) * near(l, 0.42, 0.3);
        break;
      case 'verte':
        v = near(h, 140, 45) * (0.4 + 0.6 * near(s, 0.32, 0.3)) * near(l, 0.4, 0.3);
        break;
      // La craie : clair ET désaturé. C'est la signature, pas la teinte.
      case 'craie':
        v = near(l, 0.66, 0.28) * (1 - Math.min(1, s / 0.34)) * (0.55 + 0.45 * near(h, 185, 90));
        break;
      case 'terreuse':
        v = near(h, 34, 34) * (0.35 + 0.65 * near(s, 0.34, 0.3)) * near(l, 0.36, 0.28);
        break;
      // Brassée : de l'écume par-dessus une eau teintée. Beaucoup de valeurs
      // très claires et très sombres, donc une clarté moyenne mais désaturée.
      case 'brassee':
        v = near(l, 0.5, 0.22) * (1 - Math.min(1, s / 0.26)) * near(h, 200, 80);
        break;
      default:
        v = 0;
    }
    return { water: w, v };
  });
  scores.sort((a, b) => b.v - a.v);
  const [first, second] = scores;
  const confidence = first.v <= 0 ? 0 : clamp01((first.v - (second?.v || 0)) / first.v);
  return { water: first.water, confidence, scores };
}

/** État du ciel le plus proche d'un échantillon photo pointé vers le haut. */
export function classifySky({ h, s, l }) {
  if (l < 0.12) return { sky: sky('nuit'), confidence: 0.9 };
  // Rasant : la teinte bascule dans les orangés et la clarté reste moyenne.
  if (h > 5 && h < 45 && s > 0.3 && l < 0.62) return { sky: sky('aube'), confidence: 0.7 };
  if (l < 0.34) return { sky: sky('plomb'), confidence: 0.7 };
  if (s < 0.14) return { sky: sky(l > 0.7 ? 'couvert' : 'plomb'), confidence: 0.6 };
  if (h > 180 && h < 250 && s > 0.32) return { sky: sky(l > 0.62 ? 'soleil' : 'voile'), confidence: 0.75 };
  return { sky: sky('voile'), confidence: 0.4 };
}

/** Cloche : 1 au centre, décroît sur `tol`. */
function near(x, centre, tol) {
  const d = Math.abs(x - centre) / tol;
  return Math.exp(-d * d);
}

/* --------------------------------------------------------------------------
 * 7. Pré-remplissage depuis ce que l'app sait déjà
 * --------------------------------------------------------------------------
 * Demander à l'utilisateur ce que l'app peut déduire est une faute d'ergonomie.
 * On propose un état de départ ; il n'a plus qu'à corriger ce qui ne va pas.
 * ------------------------------------------------------------------------ */

/** @param {{cloudCover?:number, turbidity?:number|null, sunAltDeg?:number|null}} o */
export function guess({ cloudCover = null, turbidity = null, sunAltDeg = null } = {}) {
  let skyId = 'couvert';
  if (sunAltDeg != null && sunAltDeg < -6) skyId = 'nuit';
  else if (sunAltDeg != null && sunAltDeg < 8) skyId = 'aube';
  else if (cloudCover != null) {
    if (cloudCover < 25) skyId = 'soleil';
    else if (cloudCover < 55) skyId = 'voile';
    else if (cloudCover < 88) skyId = 'couvert';
    else skyId = 'plomb';
  }

  // La turbidité de l'app est un indice d'énergie reçue par le fond ces
  // dernières heures — houle et vent, pondérés par le coefficient. C'est
  // exactement ce qui met la craie en suspension devant Dieppe.
  let waterId = 'verte';
  if (turbidity != null) {
    if (turbidity < 0.18) waterId = 'claire';
    else if (turbidity < 0.42) waterId = 'verte';
    else if (turbidity < 0.7) waterId = 'craie';
    else waterId = 'terreuse';
  }
  return { skyId, waterId, guessed: { sky: skyId !== 'couvert', water: turbidity != null } };
}

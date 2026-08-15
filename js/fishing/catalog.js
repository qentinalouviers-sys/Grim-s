/* ==========================================================================
 * fishing/catalog.js — recensement des espèces des côtes normandes
 * --------------------------------------------------------------------------
 * Tout ce qui se prend depuis un bateau entre la baie de Somme et le Cotentin,
 * zone CIEM 7d — poissons, céphalopodes, crustacés — plus les espèces qu'il
 * FAUT savoir reconnaître pour les relâcher.
 *
 * ── POURQUOI CE FICHIER EST SÉPARÉ DE species.js ──────────────────────────
 * species.js porte les espèces SCORÉES : chacune a une dizaine de facteurs
 * pondérés, issus de la littérature halieutique et refittables sur le journal
 * de captures. Écrire ces poids demande une raison de le faire ; les inventer
 * pour soixante espèces produirait un modèle qui a l'air savant et ne sait
 * rien. Le catalogue, lui, porte ce qu'on peut affirmer sans modèle : la
 * saison, la profondeur, le fond, la technique, la maille légale, le repère
 * d'identification. C'est déjà l'essentiel de ce qu'on cherche quand on tient
 * un poisson dans la main et qu'on se demande quoi en faire.
 *
 *   scored: true  → species.js prend le relais, l'espèce a un score horaire
 *   scored: false → fiche, saison, maille, technique. Pas de score inventé.
 *
 * ── LA MAILLE ─────────────────────────────────────────────────────────────
 * `minSizeCm: null` ne veut PAS dire « pas de taille minimale » : ça veut dire
 * que je ne la garantis pas. La distinction est écrite dans chaque fiche. Une
 * taille inventée coûte une amende ou un poisson tué pour rien — dans le doute,
 * l'app dit qu'elle ne sait pas et renvoie à l'arrêté.
 *
 * Sources : règlement (UE) 2019/1241 annexe VI, arrêtés du ministère chargé de
 * la mer pour la pêche de loisir, DIRM Manche Est – Mer du Nord. À revérifier
 * chaque année : REGULATION_META.checked porte la date du dernier contrôle.
 * La pêche à pied et les coquillages relèvent d'arrêtés préfectoraux qui
 * changent de plage en plage — ils ne sont pas ici, et c'est volontaire.
 * ========================================================================== */

import { REGULATION_META } from './species.js';

/* --------------------------------------------------------------------------
 * Groupes
 * ------------------------------------------------------------------------ */
export const GROUPS = [
  { id: 'fond', name: 'Poissons de fond', emoji: '🐟' },
  { id: 'plat', name: 'Poissons plats', emoji: '🥮' },
  { id: 'pelagique', name: 'Pélagiques', emoji: '🐠' },
  { id: 'roche', name: 'Poissons de roche et de bord', emoji: '🪨' },
  { id: 'raie', name: 'Raies et petits requins', emoji: '🦈' },
  { id: 'cephalopode', name: 'Céphalopodes', emoji: '🦑' },
  { id: 'crustace', name: 'Crustacés', emoji: '🦀' },
  { id: 'protege', name: 'À relâcher — interdits', emoji: '⛔️' },
];

/* --------------------------------------------------------------------------
 * Saisonnalité
 * --------------------------------------------------------------------------
 * Douze caractères, janvier à décembre :
 *   .  absente ou anecdotique
 *   x  présente
 *   X  pleine saison
 * Plus lisible qu'un tableau de douze nombres, et impossible à désaligner.
 * ------------------------------------------------------------------------ */
const MONTHS_FR = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];

export function seasonAt(sp, t = Date.now()) {
  const c = sp.season[new Date(t).getMonth()];
  return c === 'X' ? 'peak' : c === 'x' ? 'present' : 'off';
}

/** « avr → oct, pic juin–sep » — la saison en une ligne lisible. */
export function seasonLabel(sp) {
  const on = [];
  for (let i = 0; i < 12; i++) if (sp.season[i] !== '.') on.push(i);
  if (!on.length) return 'toute l’année';
  if (on.length === 12) return 'toute l’année';
  const peaks = [];
  for (let i = 0; i < 12; i++) if (sp.season[i] === 'X') peaks.push(i);
  const runs = [];
  let start = null;
  for (let i = 0; i < 12; i++) {
    const active = sp.season[i] !== '.';
    if (active && start === null) start = i;
    if (!active && start !== null) {
      runs.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, 11]);
  // Une saison à cheval sur le 31 décembre forme deux tronçons qui n'en sont
  // qu'un : « nov → fév » se lit, « jan–fév et nov–déc » se déchiffre.
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === 11) {
    const first = runs.shift();
    const last = runs.pop();
    runs.push([last[0], first[1] + 12]);
  }
  const txt = runs
    .map(([a, b]) => (a === b ? MONTHS_FR[a % 12] : `${MONTHS_FR[a % 12]} → ${MONTHS_FR[b % 12]}`))
    .join(', ');
  return peaks.length && peaks.length < 10
    ? `${txt} · pic ${MONTHS_FR[peaks[0]]}–${MONTHS_FR[peaks[peaks.length - 1]]}`
    : txt;
}

/* --------------------------------------------------------------------------
 * Fabrique
 * ------------------------------------------------------------------------ */
const sp = (id, name, sci, o) => ({
  id,
  name,
  sci,
  emoji: '🐟',
  color: '#64809d',
  group: 'fond',
  season: 'xxxxxxxxxxxx',
  minSizeCm: null,
  sizeUnknown: false,     // true = maille non garantie, pas « pas de maille »
  measure: null,          // pour ce qui ne se mesure pas du museau à la queue
  bag: null,
  depthM: null,
  habitat: [],
  status: 'open',         // open | restricted | forbidden
  scored: false,
  alt: [],
  ...o,
});

/* ==========================================================================
 * LE CATALOGUE
 * ========================================================================== */
export const CATALOG = [

  /* ─── Poissons de fond ─────────────────────────────────────────────── */
  sp('bar', 'Bar', 'Dicentrarchus labrax', {
    emoji: '🐟', color: '#22d3ee', group: 'fond', scored: true,
    season: 'xxxXXXXXXXx.', minSizeCm: 42, bag: 3, depthM: [3, 40],
    habitat: ['epave', 'ridin', 'roche', 'veine'],
    id_: 'Deux nageoires dorsales bien séparées, opercule à une épine plate, ligne latérale nette. Aucune tache — sinon c’est un bar moucheté.',
    technique: 'Leurre souple 12–15 cm dans la veine, vif au ballon, surface au petit jour.',
    note: 'Marquage obligatoire, déclaration de capture, 3 par jour. Fermeture en capture-relâcher du 1er février au 31 mars.',
  }),
  sp('bar-mouchete', 'Bar moucheté', 'Dicentrarchus punctatus', {
    color: '#38bdf8', group: 'fond', season: '...xxXXXxx..', sizeUnknown: true, depthM: [2, 25],
    habitat: ['sable', 'chenal', 'veine'],
    id_: 'Comme le bar, mais le dos et les flancs sont semés de petits points noirs. Plus méridional, remonte l’été.',
    technique: 'Mêmes postes que le bar, souvent plus près du bord et dans l’eau troublée.',
    note: 'Espèce distincte du bar commun : la maille et les quotas du bar ne s’y appliquent pas automatiquement. Vérifier l’arrêté.',
  }),
  sp('lieu-jaune', 'Lieu jaune', 'Pollachius pollachius', {
    emoji: '🐟', color: '#fbbf24', group: 'fond', scored: true,
    season: '....xxXXXXx.', minSizeCm: 42, bag: 2, depthM: [10, 60],
    habitat: ['epave', 'roche', 'tombant'],
    id_: 'Mâchoire inférieure proéminente, ligne latérale sombre et incurvée, pas de barbillon.',
    technique: 'Verticale au leurre souple ou au jig sur épave, madaï en dérive.',
    note: 'Interdit du 1er janvier au 30 avril, pêcher-relâcher compris. Marquage et déclaration obligatoires.',
  }),
  sp('lieu-noir', 'Lieu noir', 'Pollachius virens', {
    color: '#94a3b8', group: 'fond', season: 'xxx.....xXXx', minSizeCm: 35, depthM: [20, 100],
    habitat: ['epave', 'roche', 'pleine-eau'],
    id_: 'Ligne latérale claire et droite, mâchoire inférieure à peine saillante, queue franchement fourchue.',
    technique: 'Jig et leurres rapides sur épave profonde, souvent en chasse au-dessus de la structure.',
  }),
  sp('cabillaud', 'Cabillaud', 'Gadus morhua', {
    alt: ['morue'], color: '#a3a3a3', group: 'fond', season: 'XXx......xXX', minSizeCm: 35, depthM: [15, 80],
    habitat: ['epave', 'roche', 'ridin'],
    id_: 'Barbillon au menton, ligne latérale blanche et courbe, dos marbré olive.',
    technique: 'Traînard à ver et bibi, jig lent sur épave. Stock très diminué en Manche Est : prélever peu.',
    note: 'Espèce sous plan de reconstitution en mer du Nord et Manche Est. Le quota de loisir peut évoluer d’une année sur l’autre.',
  }),
  sp('merlan', 'Merlan', 'Merlangius merlangus', {
    color: '#cbd5e1', group: 'fond', season: 'XXxx....xxXX', minSizeCm: 27, depthM: [10, 60],
    habitat: ['sable', 'ridin', 'chenal'],
    id_: 'Tache noire à la base de la pectorale, pas de barbillon chez l’adulte, corps élancé et argenté.',
    technique: 'Trains de plumes et bas de ligne à ver sur fond sableux, souvent en bancs.',
  }),
  sp('eglefin', 'Églefin', 'Melanogrammus aeglefinus', {
    color: '#9ca3af', group: 'fond', season: 'xx........xx', minSizeCm: 30, depthM: [40, 120],
    habitat: ['sable', 'pleine-eau'],
    id_: 'Tache noire ovale sous la première dorsale — la « marque du pouce de saint Pierre » — et ligne latérale noire.',
    technique: 'Fond au ver et coquillage, sur les fosses. Peu fréquent près de Dieppe.',
  }),
  sp('merlu', 'Merlu', 'Merluccius merluccius', {
    alt: ['colin'], color: '#a8a29e', group: 'fond', season: '....xxXXXx..', minSizeCm: 27, depthM: [50, 200],
    habitat: ['pleine-eau', 'tombant'],
    id_: 'Bouche largement fendue, gueule noire, deux dorsales, corps fuselé argenté.',
    technique: 'Jig lourd et vifs en profondeur, plutôt au large.',
  }),
  sp('tacaud', 'Tacaud', 'Trisopterus luscus', {
    color: '#d6d3d1', group: 'fond', season: 'xxxxXXXXXxxx', sizeUnknown: true, depthM: [5, 50],
    habitat: ['epave', 'roche', 'ridin'],
    id_: 'Corps haut et cuivré barré de bandes sombres, gros barbillon, tache à la base de la pectorale.',
    technique: 'Se prend partout au ver. Excellent vif pour le bar et le lieu.',
    note: 'Pas de taille minimale connue à ce jour en pêche de loisir — à confirmer auprès de la DIRM.',
  }),
  sp('congre', 'Congre', 'Conger conger', {
    emoji: '🐍', color: '#57534e', group: 'fond', season: '...xxXXXXXx.', minSizeCm: 58, depthM: [10, 80],
    habitat: ['epave', 'roche'],
    id_: 'Serpentiforme, sans écailles, mâchoire supérieure plus longue que l’inférieure (l’inverse de l’anguille).',
    technique: 'Gros appât mort au fond de l’épave, bas de ligne renforcé. Attention à la gueule au décrochage.',
  }),
  sp('saint-pierre', 'Saint-Pierre', 'Zeus faber', {
    emoji: '🐡', color: '#a78bfa', group: 'fond', scored: true,
    season: '...xxXXXXx..', sizeUnknown: true, depthM: [15, 70],
    habitat: ['epave', 'roche', 'tombant'],
    id_: 'Corps très comprimé, tache ronde noire cerclée de clair sur le flanc, longs rayons dorsaux.',
    technique: 'Vif ou leurre souple posé lentement au ras de la structure. Poisson lent, il faut ralentir.',
    note: 'Pas de taille minimale réglementaire en Manche à date.',
  }),
  sp('maigre', 'Maigre', 'Argyrosomus regius', {
    color: '#fcd34d', group: 'fond', season: '....xXXXXx..', minSizeCm: 45, depthM: [5, 50],
    habitat: ['chenal', 'sable', 'veine'],
    id_: 'Grand corps argenté, bouche jaune à l’intérieur, ligne latérale marquée. Grogne quand on le sort.',
    technique: 'Leurre souple lourd et vif dans les courants d’estuaire. Espèce en expansion vers le nord.',
  }),
  sp('grondin-perlon', 'Grondin perlon', 'Chelidonichthys lucerna', {
    alt: ['grondin rouge'], color: '#fb7185', group: 'fond', season: '..xxXXXXXXx.', sizeUnknown: true, depthM: [10, 60],
    habitat: ['sable', 'sablo-vaseux'],
    id_: 'Tête cuirassée, trois rayons libres sous chaque pectorale qui servent de pattes, pectorales bleu vif déployées.',
    technique: 'Traîne lente sur le sable, ver et lanière de maquereau au fond.',
  }),
  sp('grondin-gris', 'Grondin gris', 'Eutrigla gurnardus', {
    color: '#94a3b8', group: 'fond', season: 'xxxxXXXXXXxx', sizeUnknown: true, depthM: [10, 80],
    habitat: ['sable', 'sablo-vaseux'],
    id_: 'Plus terne que le perlon, tache noire sur la première dorsale, ligne latérale à écussons clairs.',
    technique: 'Même pêche que le perlon, souvent mêlé aux merlans.',
  }),
  sp('rouget-barbet', 'Rouget-barbet', 'Mullus surmuletus', {
    color: '#f87171', group: 'fond', season: '...xxXXXXXx.', minSizeCm: 15, depthM: [5, 50],
    habitat: ['sable', 'sable-coquillier', 'roche'],
    id_: 'Deux longs barbillons sous le menton, robe rouge-rosé à bandes jaunes, profil de tête très incliné.',
    technique: 'Petit ver sur fond de sable coquillier, bas de ligne fin, à la dérive.',
  }),
  sp('dorade-grise', 'Dorade grise', 'Spondyliosoma cantharus', {
    emoji: '🐟', color: '#a3e635', group: 'fond', scored: true,
    season: '...xXXXXXx..', minSizeCm: 23, depthM: [10, 50],
    habitat: ['epave', 'roche', 'ridin'],
    id_: 'Corps ovale gris argenté à reflets, lignes longitudinales dorées, œil grand. En groupe au-dessus des structures.',
    technique: 'Bas de ligne fin, ver ou couteau, amorçage. Elle se tient au-dessus de l’épave, pas dedans.',
    note: 'Marquage obligatoire.',
  }),
  sp('dorade-royale', 'Dorade royale', 'Sparus aurata', {
    color: '#facc15', group: 'fond', season: '....xxXXXx..', minSizeCm: 23, depthM: [2, 30],
    habitat: ['sable', 'chenal', 'sable-coquillier'],
    id_: 'Bande dorée entre les yeux, tache noire sur l’opercule, corps massif argenté.',
    technique: 'Crabe mou, couteau, moule sur fond coquillier. Remonte de plus en plus haut en Manche.',
  }),
  sp('sar', 'Sar commun', 'Diplodus sargus', {
    color: '#e2e8f0', group: 'roche', season: '...xxXXXXx..', minSizeCm: 23, depthM: [1, 25],
    habitat: ['roche', 'tombant'],
    id_: 'Corps argenté barré de bandes verticales sombres, large tache noire sur le pédoncule caudal.',
    technique: 'Crabe, moule, ver à proximité immédiate de la roche.',
  }),
  sp('bogue', 'Bogue', 'Boops boops', {
    color: '#cbd5e1', group: 'pelagique', season: '...xxXXXXx..', sizeUnknown: true, depthM: [5, 40],
    habitat: ['pleine-eau', 'roche'],
    id_: 'Grand œil, corps fuselé argenté à fines lignes dorées, bouche petite.',
    technique: 'Petits appâts en pleine eau. Bon vif.',
  }),
  sp('mulet', 'Mulet porc', 'Chelon labrosus', {
    color: '#d1d5db', group: 'fond', season: '..xxXXXXXXx.', minSizeCm: 30, depthM: [0, 15],
    habitat: ['chenal', 'vase', 'sable'],
    id_: 'Lèvre supérieure épaisse et verruqueuse, corps gris fuselé, écailles larges. En surface dans les ports.',
    technique: 'Pain, ver, esche fine sous flotteur dans les chenaux et les bassins.',
  }),
  sp('orphie', 'Orphie', 'Belone belone', {
    alt: ['aiguillette'], color: '#4ade80', group: 'pelagique', season: '....xXXXx...', sizeUnknown: true, depthM: [0, 20],
    habitat: ['pleine-eau'],
    id_: 'Long bec garni de dents, corps très allongé. Les arêtes sont vertes — c’est normal, et sans danger.',
    technique: 'Petit leurre rapide en surface, souvent au milieu des bancs de maquereaux.',
  }),
  sp('lancon', 'Lançon', 'Ammodytes tobianus', {
    color: '#fde68a', group: 'pelagique', season: '...xXXXXXx..', sizeUnknown: true, depthM: [0, 30],
    habitat: ['sable', 'banc-de-sable'],
    id_: 'Corps effilé argenté, mâchoire inférieure pointue, s’enfouit dans le sable.',
    technique: 'Ratissage du sable à basse mer, ou trains de plumes minuscules. C’est LE vif du bar.',
  }),
  sp('vive', 'Petite vive', 'Echiichthys vipera', {
    emoji: '⚠️', color: '#f59e0b', group: 'fond', season: '...xxXXXXx..', sizeUnknown: true, depthM: [1, 30],
    habitat: ['sable'],
    id_: 'Petit poisson beige enfoui dans le sable, première dorsale NOIRE dressée.',
    technique: 'Prise accidentelle sur le sable. Ne se pêche pas volontairement.',
    caution: 'VENIMEUSE. Épines dorsales et opercules. Ne jamais saisir à main nue : décrocher à la pince. En cas de piqûre, tremper la zone dans l’eau la plus chaude supportable (45 °C) — le venin est thermolabile — et consulter.',
  }),
  sp('rascasse-chabot', 'Chabot de mer', 'Myoxocephalus scorpius', {
    color: '#a16207', group: 'roche', season: 'XXxx....xxXX', sizeUnknown: true, depthM: [1, 30],
    habitat: ['roche', 'sable'],
    id_: 'Grosse tête épineuse, bouche énorme, corps trapu marbré.',
    technique: 'Prise fréquente au ver. Épines vulnérantes mais non venimeuses : décrocher à la pince.',
  }),
  sp('vieille', 'Vieille', 'Labrus bergylta', {
    color: '#34d399', group: 'roche', season: '..xxXXXXXXx.', sizeUnknown: true, depthM: [3, 40],
    habitat: ['roche', 'tombant'],
    id_: 'Corps épais vert-brun marbré de clair, lèvres charnues, dents saillantes.',
    technique: 'Crabe et ver au ras de la roche. Combat court et brutal.',
  }),
  sp('baudroie', 'Baudroie', 'Lophius piscatorius', {
    alt: ['lotte'], color: '#78716c', group: 'fond', season: 'xxxxxxxxxxxx', sizeUnknown: true, depthM: [20, 150],
    habitat: ['sable', 'vase', 'sablo-vaseux'],
    id_: 'Tête énorme et aplatie, gueule immense, leurre pêcheur dressé sur le museau.',
    technique: 'Prise occasionnelle sur appât de fond. Manipuler à la pince : la gueule est râpeuse.',
  }),

  /* ─── Poissons plats ───────────────────────────────────────────────── */
  sp('sole', 'Sole', 'Solea solea', {
    emoji: '🥮', color: '#d4a373', group: 'plat', season: 'xxXXXXxxxXXx', minSizeCm: 24, depthM: [2, 40],
    habitat: ['sable', 'sablo-vaseux', 'vase'],
    id_: 'Ovale allongée, yeux à droite, bouche en position basse et arrondie, tache noire sur la pectorale.',
    technique: 'Ver de chalut ou dur, traînard léger sur le sable, de nuit ou dans l’eau troublée.',
  }),
  sp('plie', 'Plie', 'Pleuronectes platessa', {
    alt: ['carrelet'], emoji: '🥮', color: '#fb923c', group: 'plat', season: 'xxx..xxxXXXX',
    minSizeCm: 27, depthM: [3, 60], habitat: ['sable', 'sable-coquillier'],
    id_: 'Yeux à droite, taches ORANGE vif sur le dos, peau lisse, ligne d’osselets derrière l’œil.',
    technique: 'Ver et couteau sur fond sableux, en dérive lente.',
  }),
  sp('limande', 'Limande', 'Limanda limanda', {
    emoji: '🥮', color: '#fdba74', group: 'plat', season: 'XXxxxxxxxxXX', minSizeCm: 20, depthM: [5, 60],
    habitat: ['sable', 'sable-coquillier'],
    id_: 'Yeux à droite, peau RÊCHE au toucher dans le sens de la queue, ligne latérale fortement courbée sur la pectorale.',
    technique: 'Bas de ligne à deux hameçons fins, ver, dérive sur le sable.',
  }),
  sp('limande-sole', 'Limande-sole', 'Microstomus kitt', {
    emoji: '🥮', color: '#fed7aa', group: 'plat', season: 'xxxxxxXXXXxx', minSizeCm: 25, depthM: [10, 80],
    habitat: ['sable', 'roche', 'sable-coquillier'],
    id_: 'Corps ovale et épais, peau très lisse et glissante, marbrures brunes et jaunes.',
    technique: 'Ver sur fonds mixtes, souvent en bordure de roche.',
  }),
  sp('flet', 'Flet', 'Platichthys flesus', {
    emoji: '🥮', color: '#a8a29e', group: 'plat', season: 'xxxxxx..xXXX', minSizeCm: 20, depthM: [0, 30],
    habitat: ['vase', 'sablo-vaseux', 'chenal'],
    id_: 'Tubercules râpeux à la base des nageoires et sur la ligne latérale. Supporte l’eau douce : on le trouve en estuaire.',
    technique: 'Ver en estuaire et dans les chenaux, sur fond vaseux.',
  }),
  sp('turbot', 'Turbot', 'Scophthalmus maximus', {
    emoji: '🥮', color: '#e879f9', group: 'plat', scored: true,
    season: '...xXXXXXx..', minSizeCm: 30, depthM: [5, 50],
    habitat: ['banc-de-sable', 'ridin', 'sable'],
    id_: 'Presque rond, yeux à GAUCHE, pas d’écailles mais des tubercules osseux épars sur le dos.',
    technique: 'Vif ou lanière sur les ridins, dérive lente à contre-courant. Le poste compte plus que l’appât.',
  }),
  sp('barbue', 'Barbue', 'Scophthalmus rhombus', {
    emoji: '🥮', color: '#f0abfc', group: 'plat', season: '...xXXXXXx..', minSizeCm: 30, depthM: [5, 60],
    habitat: ['sable', 'banc-de-sable', 'ridin'],
    id_: 'Comme le turbot mais plus ovale, PAS de tubercules, peau lisse et écailleuse.',
    technique: 'Mêmes postes que le turbot, souvent un peu plus sur le sable franc.',
  }),
  sp('cardine', 'Cardine', 'Lepidorhombus whiffiagonis', {
    emoji: '🥮', color: '#e5e7eb', group: 'plat', season: 'xxxxxxxxxxxx', minSizeCm: 20, depthM: [40, 200],
    habitat: ['vase', 'sablo-vaseux'],
    id_: 'Corps mince et translucide, yeux à gauche, grande bouche. Se prend au large, sur la vase.',
    technique: 'Appât de fond en profondeur. Chair fine mais fragile.',
  }),

  /* ─── Pélagiques ───────────────────────────────────────────────────── */
  sp('maquereau', 'Maquereau', 'Scomber scombrus', {
    emoji: '🐠', color: '#38bdf8', group: 'pelagique', scored: true,
    season: '...xXXXXXXx.', minSizeCm: 20, bag: 10, depthM: [0, 60],
    habitat: ['pleine-eau', 'veine'],
    id_: 'Dos bleu-vert zébré de noir, ventre argenté sans tache, corps fuselé, pas de vessie natatoire.',
    technique: 'Train de plumes, mitraillette, petit jig. Chercher les oiseaux et la chasse.',
    note: 'Quota de 10 par jour et par personne, relâchés ou non. Marquage et déclaration obligatoires.',
  }),
  sp('chinchard', 'Chinchard', 'Trachurus trachurus', {
    alt: ['saurel'], emoji: '🐠', color: '#7dd3fc', group: 'pelagique', season: '...xxXXXXXx.',
    minSizeCm: 15, depthM: [5, 80], habitat: ['pleine-eau', 'epave'],
    id_: 'Ligne latérale armée d’écussons osseux tranchants, grand œil, tache noire sur l’opercule.',
    technique: 'Mitraillette au-dessus des épaves, souvent mêlé aux maquereaux.',
  }),
  sp('hareng', 'Hareng', 'Clupea harengus', {
    emoji: '🐠', color: '#bae6fd', group: 'pelagique', season: 'xx........XX', minSizeCm: 20, depthM: [5, 60],
    habitat: ['pleine-eau'],
    id_: 'Corps argenté comprimé, écailles caduques, ventre lisse sans carène tranchante, une seule dorsale.',
    technique: 'Mitraillette à petits hameçons en fin d’automne. Frai côtier au large de Dieppe.',
  }),
  sp('sardine', 'Sardine', 'Sardina pilchardus', {
    emoji: '🐠', color: '#93c5fd', group: 'pelagique', season: '....xXXXXx..', minSizeCm: 11, depthM: [0, 40],
    habitat: ['pleine-eau'],
    id_: 'Stries rayonnantes sur l’opercule, rangée de taches sombres sur le flanc, dorsale avancée.',
    technique: 'Mitraillette fine de nuit sous la lumière.',
  }),
  sp('anchois', 'Anchois', 'Engraulis encrasicolus', {
    emoji: '🐠', color: '#a5b4fc', group: 'pelagique', season: '....xXXXx...', minSizeCm: 12, depthM: [0, 40],
    habitat: ['pleine-eau'],
    id_: 'Museau pointu débordant la mâchoire, bouche très fendue, bande argentée sur le flanc.',
    technique: 'Prise de hasard à la mitraillette. Bon vif quand il est là.',
  }),
  sp('sprat', 'Sprat', 'Sprattus sprattus', {
    color: '#c7d2fe', group: 'pelagique', season: 'xx......xxXX', sizeUnknown: true, depthM: [0, 40],
    habitat: ['pleine-eau'],
    id_: 'Comme un petit hareng, mais ventre à écailles CARÉNÉES et tranchantes sous le doigt.',
    technique: 'Appât et vif. Les bancs attirent le bar et le lieu en hiver.',
  }),
  sp('bonite', 'Bonite à dos rayé', 'Sarda sarda', {
    emoji: '🐠', color: '#2dd4bf', group: 'pelagique', season: '.......xXXx.', sizeUnknown: true, depthM: [0, 50],
    habitat: ['pleine-eau'],
    id_: 'Rayures obliques sombres sur le dos, corps de thonidé, dents visibles.',
    technique: 'Traîne rapide et leurres de surface sur les chasses de fin d’été. Remonte de plus en plus souvent.',
  }),
  sp('thon-rouge', 'Thon rouge', 'Thunnus thynnus', {
    emoji: '🐟', color: '#ef4444', group: 'pelagique', status: 'restricted',
    season: '.......xXXx.', minSizeCm: 115, bag: 1, depthM: [0, 200],
    habitat: ['pleine-eau'],
    id_: 'Pectorales courtes, corps massif, finelets jaunes bordés de sombre.',
    technique: 'Chasses de fin d’été au large. Matériel lourd obligatoire.',
    note: 'AUTORISATION NOMINATIVE ANNUELLE obligatoire, bague de marquage à commander avant la sortie, déclaration de capture. Sans autorisation, la capture est interdite et le poisson doit être relâché.',
  }),

  /* ─── Raies et petits requins ──────────────────────────────────────── */
  sp('raie-bouclee', 'Raie bouclée', 'Raja clavata', {
    emoji: '🦈', color: '#fb923c', group: 'raie', scored: true,
    season: 'xxXXXXxxxXXx', minSizeCm: 45, depthM: [10, 80],
    habitat: ['sable', 'sablo-vaseux', 'ridin'],
    id_: 'Gros boutons épineux (« boucles ») sur le dos et la queue, dos marbré. Mesure du museau au bout de la queue.',
    technique: 'Empile forte, lanière de maquereau ou de seiche posée sur le sable, à l’étale ou en petit courant.',
    note: 'Plusieurs espèces de raies sont interdites : identifier avant de conserver.',
  }),
  sp('raie-lisse', 'Raie douce', 'Raja montagui', {
    emoji: '🦈', color: '#fdba74', group: 'raie', season: 'xxxxxxxxxxxx', sizeUnknown: true, depthM: [20, 100],
    habitat: ['sable', 'sablo-vaseux'],
    id_: 'Dos lisse semé de petites taches sombres qui ne touchent PAS le bord du disque, sans grosses boucles.',
    technique: 'Mêmes montages que la bouclée.',
    note: 'Identification délicate. Dans le doute, relâcher.',
  }),
  sp('raie-brunette', 'Raie brunette', 'Raja undulata', {
    emoji: '🦈', color: '#c084fc', group: 'raie', status: 'restricted', season: 'xxxxxxxxxxxx',
    sizeUnknown: true, depthM: [10, 60], habitat: ['sable', 'roche'],
    id_: 'Dessin d’ondulations brunes bordées de points blancs — très reconnaissable.',
    technique: 'Prise accidentelle sur montage à raie.',
    note: 'Espèce sous restriction en Manche : capture très encadrée, souvent interdite en pêche de loisir. Relâcher sauf certitude sur l’arrêté en vigueur.',
  }),
  sp('roussette', 'Petite roussette', 'Scyliorhinus canicula', {
    emoji: '🦈', color: '#d6d3d1', group: 'raie', season: 'xxxxxxxxxxxx', sizeUnknown: true, depthM: [10, 100],
    habitat: ['sable', 'sablo-vaseux', 'roche'],
    id_: 'Petit requin beige à taches brunes, peau très râpeuse, narines reliées à la bouche par un sillon.',
    technique: 'Se prend sur tout appât de fond. Manipuler avec un chiffon : la peau râpe la main.',
  }),
  sp('emissole', 'Émissole', 'Mustelus asterias', {
    emoji: '🦈', color: '#e7e5e4', group: 'raie', season: '...xxXXXXx..', sizeUnknown: true, depthM: [5, 60],
    habitat: ['sable', 'ridin'],
    id_: 'Requin élancé gris à petites taches blanches, dents en pavage (elle broie les crabes).',
    technique: 'Crabe mou sur le sable, en courant. Combat rapide et long.',
  }),

  /* ─── Céphalopodes ─────────────────────────────────────────────────── */
  sp('seiche', 'Seiche', 'Sepia officinalis', {
    emoji: '🦑', color: '#f472b6', group: 'cephalopode', season: 'x..xXXXx...x',
    sizeUnknown: true, depthM: [2, 40], habitat: ['sable', 'roche', 'chenal'],
    id_: 'Corps ovale à os interne calcaire, huit bras et deux tentacules rétractiles, nageoire tout le tour du manteau.',
    technique: 'Turlutte en dérive au printemps, quand elle monte pondre. Remonter lentement, elle décroche.',
  }),
  sp('encornet', 'Encornet', 'Loligo vulgaris', {
    alt: ['calmar'], emoji: '🦑', color: '#f9a8d4', group: 'cephalopode', season: 'xx.......xXX',
    sizeUnknown: true, depthM: [5, 60], habitat: ['pleine-eau', 'epave'],
    id_: 'Corps allongé en fuseau, nageoires en losange à l’arrière, plume interne cornée et souple.',
    technique: 'Turlutte lumineuse de nuit à l’automne, sous les lampes ou au-dessus des épaves.',
  }),
  sp('poulpe', 'Poulpe', 'Octopus vulgaris', {
    emoji: '🐙', color: '#c084fc', group: 'cephalopode', season: '.......xXXXx',
    sizeUnknown: true, depthM: [2, 40], habitat: ['roche', 'epave'],
    id_: 'Huit bras à double rangée de ventouses, pas de coquille interne.',
    technique: 'Leurre crabe traîné au fond sur la roche. Population très variable d’une année à l’autre.',
  }),

  /* ─── Crustacés ────────────────────────────────────────────────────── */
  sp('homard', 'Homard européen', 'Homarus gammarus', {
    emoji: '🦞', color: '#3b82f6', group: 'crustace', season: '..xxXXXXXXx.',
    minSizeCm: 8.7, measure: 'longueur céphalothorax (de l’orbite à l’arrière du corps)',
    depthM: [3, 40], habitat: ['roche', 'epave'],
    id_: 'Bleu sombre marbré, deux pinces dissemblables — une broyeuse, une coupante.',
    technique: 'Casier appâté sur la roche. Une femelle grainée se remet à l’eau, sans exception.',
    note: 'Marquage obligatoire des captures de loisir. Taille : 87 mm de céphalothorax.',
  }),
  sp('tourteau', 'Tourteau', 'Cancer pagurus', {
    emoji: '🦀', color: '#f97316', group: 'crustace', season: '..xxXXXXXXx.',
    minSizeCm: 14, measure: 'largeur de la carapace',
    depthM: [3, 60], habitat: ['roche', 'epave'],
    id_: 'Carapace ovale brun-rouge à bord festonné « en pâte à tarte », pinces à extrémités noires.',
    technique: 'Casier. Femelles grainées relâchées.',
  }),
  sp('araignee', 'Araignée de mer', 'Maja squinado', {
    emoji: '🦀', color: '#f43f5e', group: 'crustace', season: '..xXXXXx....',
    minSizeCm: 12, measure: 'longueur de la carapace',
    depthM: [3, 50], habitat: ['roche', 'sable'],
    id_: 'Carapace épineuse en forme de poire, longues pattes, souvent couverte d’algues.',
    technique: 'Casier au printemps, pendant la migration côtière.',
  }),
  sp('etrille', 'Étrille', 'Necora puber', {
    emoji: '🦀', color: '#fb7185', group: 'crustace', season: 'xxxxXXXXXXxx',
    minSizeCm: 6.5, measure: 'largeur de la carapace',
    depthM: [0, 30], habitat: ['roche'],
    id_: 'Yeux rouges, dernière paire de pattes aplatie en palette natatoire, carapace velue.',
    technique: 'Casier et pêche à pied. Agressive : pince fort.',
  }),
  sp('bouquet', 'Bouquet', 'Palaemon serratus', {
    emoji: '🦐', color: '#fda4af', group: 'crustace', season: 'x......xXXXx',
    minSizeCm: 5, measure: 'longueur totale',
    depthM: [0, 15], habitat: ['roche'],
    id_: 'Crevette translucide à rostre denté relevé, rayures fines brun-rouge.',
    technique: 'Balance appâtée dans les trous de roche, en grande marée d’automne.',
  }),

  /* ─── Interdits : à savoir reconnaître pour relâcher ───────────────── */
  sp('anguille', 'Anguille européenne', 'Anguilla anguilla', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: 'xxxxxxxxxxxx',
    id_: 'Serpentiforme, mâchoire INFÉRIEURE plus longue que la supérieure (l’inverse du congre), petites écailles enfouies.',
    note: 'Espèce en danger critique. La pêche de loisir de l’anguille est interdite en eaux maritimes. Relâcher immédiatement, avec ménagement.',
  }),
  sp('saumon', 'Saumon atlantique', 'Salmo salar', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: 'xxxxxxxxxxxx',
    id_: 'Corps fuselé argenté à taches noires en X au-dessus de la ligne latérale, pédoncule caudal étroit.',
    note: 'Capture interdite en mer. En rivière, timbre et déclaration obligatoires.',
  }),
  sp('alose', 'Alose feinte', 'Alosa fallax', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: '..xxXX......',
    id_: 'Ressemble à un grand hareng, avec une rangée de taches sombres derrière l’opercule.',
    note: 'Espèce protégée, en fort déclin. Relâcher.',
  }),
  sp('requin-taupe', 'Requin-taupe commun', 'Lamna nasus', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: 'xxxxxxxxxxxx',
    id_: 'Requin trapu gris-bleu, quille caudale marquée, première dorsale à extrémité arrière blanche.',
    note: 'Capture et détention interdites. Décrocher dans l’eau si possible.',
  }),
  sp('aiguillat', 'Aiguillat commun', 'Squalus acanthias', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: 'xxxxxxxxxxxx',
    id_: 'Petit requin gris à taches blanches, une ÉPINE devant chaque dorsale.',
    note: 'Espèce interdite de détention en Atlantique Nord-Est. Relâcher — attention aux épines.',
  }),
  sp('ange-de-mer', 'Ange de mer', 'Squatina squatina', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: 'xxxxxxxxxxxx',
    id_: 'Entre la raie et le requin : corps aplati, larges pectorales, mais branchies latérales.',
    note: 'En danger critique d’extinction, strictement protégé. Relâcher immédiatement et signaler la capture.',
  }),
  sp('pocheteau', 'Pocheteau gris', 'Dipturus batis', {
    emoji: '⛔️', color: '#fb5a72', group: 'protege', status: 'forbidden', season: 'xxxxxxxxxxxx',
    id_: 'Très grande raie au museau long et pointu, dos gris-vert à petits points clairs.',
    note: 'Espèce interdite. Relâcher sans la sortir de l’eau si sa taille l’impose.',
  }),
];

/* ==========================================================================
 * Accès
 * ========================================================================== */
const BY_ID = new Map(CATALOG.map((s) => [s.id, s]));

export const findSpecies = (id) => BY_ID.get(id) || null;
export const count = () => CATALOG.length;
export const catchable = () => CATALOG.filter((s) => s.status !== 'forbidden');

/** Recherche par nom, nom alternatif ou nom scientifique, insensible aux accents. */
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function search(query) {
  const q = fold(query.trim());
  if (!q) return CATALOG;
  return CATALOG.filter((s) =>
    fold(s.name).includes(q)
    || fold(s.sci).includes(q)
    || s.alt.some((a) => fold(a).includes(q)));
}

/** Espèces de saison, les pics d'abord. */
export function inSeason(t = Date.now()) {
  return CATALOG
    .filter((s) => s.status !== 'forbidden' && seasonAt(s, t) !== 'off')
    .sort((a, b) => (seasonAt(b, t) === 'peak' ? 1 : 0) - (seasonAt(a, t) === 'peak' ? 1 : 0));
}

/**
 * Verdict de maille. Trois réponses possibles, et la troisième compte autant
 * que les deux autres : « je ne sais pas » vaut mieux qu'un chiffre inventé
 * quand c'est une amende ou un poisson tué pour rien qui est au bout.
 * @returns {{verdict:'legal'|'undersize'|'unknown'|'forbidden', minSizeCm:number|null, measure:string|null}}
 */
export function sizeCheck(id, lengthCm) {
  const s = findSpecies(id);
  if (!s) return { verdict: 'unknown', minSizeCm: null, measure: null };
  if (s.status === 'forbidden') return { verdict: 'forbidden', minSizeCm: null, measure: null };
  if (s.minSizeCm == null) return { verdict: 'unknown', minSizeCm: null, measure: s.measure };
  if (!Number.isFinite(lengthCm)) return { verdict: 'unknown', minSizeCm: s.minSizeCm, measure: s.measure };
  return {
    verdict: lengthCm >= s.minSizeCm ? 'legal' : 'undersize',
    minSizeCm: s.minSizeCm,
    measure: s.measure,
  };
}

export const META = REGULATION_META;

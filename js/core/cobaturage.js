/* ==========================================================================
 * core/cobaturage.js — les règles du partage de frais
 * --------------------------------------------------------------------------
 * CE FICHIER EXISTE POUR EMPÊCHER UNE INFRACTION, PAS POUR LA SIGNALER.
 *
 * Embarquer quelqu'un contre de l'argent sur un bateau de plaisance, c'est du
 * transport de passagers : navire classé, skipper professionnel, assurance
 * commerciale, immatriculation, cotisations. Le cobaturage n'échappe à cela
 * que sous trois conditions, et elles ne se négocient pas :
 *
 *   1. PARTAGE DE FRAIS RÉELS. Rien que ce que la sortie a coûté.
 *   2. ZÉRO BÉNÉFICE. Un euro de plus et c'est une prestation.
 *   3. LE CAPITAINE PAIE SA PART. Il embarque parce qu'il sortait de toute
 *      façon ; il ne fait pas payer sa sortie par ses invités.
 *
 * D'où le choix de conception central : **l'app calcule un plafond, elle ne
 * laisse jamais saisir un prix.** Un champ « prix par personne » aurait rendu
 * l'infraction possible en une frappe ; un plafond calculé la rend impossible
 * sans modifier le code — et le serveur refait le calcul de son côté, donc
 * même modifier le code ne suffit pas.
 *
 * ── CE QUI ENTRE DANS LA CAISSE DE BORD, ET CE QUI N'Y ENTRE PAS ──────────
 * Recevable : ce que la sortie du jour a consommé — carburant, droits de port
 * ramenés à la journée, avitaillement du bord, appâts et glace.
 *
 * Pas recevable, et c'est ce qui fait basculer les gens de bonne foi :
 * l'assurance annuelle, l'entretien, la place à l'année, l'achat du bateau,
 * son amortissement. Ce sont des charges de propriétaire. Les répartir sur des
 * équipiers, c'est leur faire payer la possession du bateau — autrement dit
 * en tirer un revenu.
 *
 * ── CE QUE CE MODULE NE FAIT PAS ─────────────────────────────────────────
 * Il ne touche pas à l'argent, et l'app non plus. Encaisser puis reverser
 * ferait de l'app un intermédiaire de paiement, avec ses propres obligations,
 * et transformerait le partage en transaction. La participation se règle
 * entre les personnes, à bord.
 *
 * Il ne remplace pas non plus un conseil juridique, et le dire n'est pas une
 * précaution de style : les textes évoluent, et c'est le capitaine qui répond
 * de sa sortie.
 * ========================================================================== */

/**
 * Les postes recevables. L'ordre est celui du formulaire.
 * `perDay` : la valeur saisie vaut pour la sortie entière, pas par personne.
 */
export const COST_ITEMS = [
  { id: 'fuel', name: 'Carburant', hint: 'Ce que la sortie a réellement brûlé.' },
  { id: 'port', name: 'Port / mouillage', hint: 'Ramené à la journée, pas la place à l’année.' },
  { id: 'bait', name: 'Appâts, glace', hint: 'Vifs, esches, pain de glace.' },
  { id: 'food', name: 'Avitaillement', hint: 'Eau, café, casse-croûte du bord.' },
];

/**
 * Les postes explicitement REFUSÉS, et la raison.
 *
 * Ils sont listés — et montrés à l'écran — plutôt que simplement absents :
 * quelqu'un de bonne foi qui ne les voit nulle part se demande où saisir son
 * assurance, et finit par la glisser dans « carburant ». Les nommer pour les
 * écarter vaut mieux que de les taire.
 */
export const REFUSED_ITEMS = [
  { id: 'insurance', name: 'Assurance annuelle', why: 'Charge de propriétaire : elle court que tu sortes ou non.' },
  { id: 'upkeep', name: 'Entretien, carénage', why: 'Idem — l’entretien du bateau n’est pas un frais de sortie.' },
  { id: 'berth', name: 'Place à l’année', why: 'Seule la journée de port compte, pas l’abonnement.' },
  { id: 'boat', name: 'Achat, amortissement', why: 'La faire payer, c’est tirer un revenu du bateau.' },
];

/** Plafond de bon sens, par personne et par sortie, en centimes. */
export const SANITY_CAP_C = 15_000;

const round = (c) => Math.max(0, Math.round(c || 0));

/**
 * Le calcul, et le seul qui fasse foi.
 *
 * @param {object} costs  centimes par poste recevable — les autres clés sont ignorées
 * @param {number} seats  places offertes aux équipiers (le capitaine n'en est pas)
 * @returns {{
 *   totalC:number, shareC:number, headcount:number,
 *   captainC:number, ok:boolean, reason:string|null
 * }}
 */
export function share(costs, seats) {
  const n = Math.floor(Number(seats) || 0);

  let totalC = 0;
  for (const it of COST_ITEMS) totalC += round(costs?.[it.id]);

  /* +1 : LE CAPITAINE. C'est toute la différence entre un partage et une
   * prestation. Diviser par le seul nombre d'équipiers lui ferait rembourser
   * l'intégralité de sa sortie — c'est-à-dire naviguer gratuitement grâce à
   * ses passagers, ce qui est exactement ce que la loi appelle un bénéfice. */
  const headcount = n + 1;
  const shareC = n > 0 ? Math.floor(totalC / headcount) : 0;

  let ok = true;
  let reason = null;

  if (n < 1) {
    ok = false;
    reason = 'Il faut au moins une place à partager.';
  } else if (n > 11) {
    /* Au-delà de douze personnes à bord, on quitte la plaisance de toute
     * façon : c'est un navire à passagers, avec tout ce qui l'accompagne. */
    ok = false;
    reason = 'Au-delà de 12 personnes à bord, ce n’est plus de la plaisance.';
  } else if (totalC <= 0) {
    ok = false;
    reason = 'Renseigne les frais réels de la sortie.';
  } else if (shareC > SANITY_CAP_C) {
    /* Non pas parce que ce serait illégal en soi — une longue sortie coûte
     * cher — mais parce qu'un montant pareil vient presque toujours d'une
     * saisie en euros là où on attendait des centimes, ou d'un poste qui n'a
     * rien à faire là. Mieux vaut faire vérifier. */
    ok = false;
    reason = 'Part par personne inhabituellement élevée — vérifie les montants saisis.';
  }

  return {
    totalC,
    shareC,
    headcount,
    captainC: ok ? totalC - shareC * n : totalC,
    ok,
    reason,
  };
}

/**
 * Ce que le capitaine peut demander, au plus.
 *
 * Séparé de `share()` pour que le serveur puisse le rejouer sans rien
 * connaître de l'affichage : il reçoit les frais et le nombre de places, il
 * recalcule, il refuse au-delà. Un client modifié ne gagne rien.
 */
export function ceiling(costs, seats) {
  const s = share(costs, seats);
  return s.ok ? s.shareC : 0;
}

/**
 * La demande tient-elle dans le plafond ?
 * @returns {{ok:boolean, reason:string|null, ceilingC:number}}
 */
export function validate(costs, seats, askedC) {
  const s = share(costs, seats);
  if (!s.ok) return { ok: false, reason: s.reason, ceilingC: 0 };

  const asked = round(askedC);
  if (asked > s.shareC) {
    return {
      ok: false,
      ceilingC: s.shareC,
      reason: `Au-delà du partage des frais : ${euros(s.shareC)} au maximum par personne.`,
    };
  }
  return { ok: true, reason: null, ceilingC: s.shareC };
}

/** Centimes → « 12,50 € ». */
export function euros(c) {
  return `${(round(c) / 100).toFixed(2).replace('.', ',')} €`;
}

/* ==========================================================================
 * La mention que le capitaine accepte une fois
 * --------------------------------------------------------------------------
 * Le point sur l'assurance n'est pas décoratif. Les polices de plaisance
 * excluent les « passagers payants », et l'appréciation d'une simple
 * participation à la caisse de bord n'est pas tranchée. En cas d'accident,
 * c'est la question que posera l'assureur — et personne n'a envie de la
 * découvrir à ce moment-là.
 * ========================================================================== */
export const CAPTAIN_TERMS = [
  'Je sortais de toute façon : je partage une sortie, je ne vends pas une prestation.',
  'La participation couvre uniquement les frais réels du jour, et je paie ma propre part.',
  'J’ai vérifié auprès de mon assureur que ma police couvre des équipiers en partage de frais.',
  'Je reste chef de bord : sécurité, équipement, décision de sortir ou de rentrer.',
  'Les prises se partagent à bord — la pêche de loisir ne se vend pas.',
];

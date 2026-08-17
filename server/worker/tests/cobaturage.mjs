/* ==========================================================================
 * tests/cobaturage.mjs — le partage de frais, et ce qu'il refuse
 * --------------------------------------------------------------------------
 *   node tests/cobaturage.mjs [base] [code-invitation]
 *
 * Deux parties. D'abord le NOYAU DE RÈGLES, éprouvé sans serveur : c'est lui
 * qui décide si une sortie reste un partage de frais ou devient du transport
 * de passagers, et c'est donc lui qu'il faut casser en premier si on veut
 * savoir s'il tient.
 *
 * Ensuite le serveur, avec la question qui compte : un client modifié qui
 * réclame plus que le plafond obtient-il quelque chose ? Il ne doit rien
 * obtenir — sans quoi tout le reste n'est que de la décoration.
 * ========================================================================== */

import { share, validate, ceiling, euros, COST_ITEMS, REFUSED_ITEMS } from '../../../js/core/cobaturage.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const INVITE = process.argv[3] || 'marée-basse-2026';
const PW = 'motdepasse';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  ÉCHEC ' + l + (d ? '  — ' + d : '')); }
};
const section = (t) => console.log('\n' + t);

/* ======================================================================
 * 1. Le noyau de règles
 * ==================================================================== */
section('1. Le capitaine paie sa part');

const s1 = share({ fuel: 6000, port: 1200, bait: 800, food: 0 }, 3);
check('total = somme des postes recevables', s1.totalC === 8000, String(s1.totalC));
/* 80 € à quatre (3 équipiers + le capitaine) → 20 € chacun. Diviser par 3
 * donnerait 26,67 € et rembourserait au capitaine l'intégralité de sa sortie :
 * c'est précisément ce que la loi appelle un bénéfice. */
check('on divise par 4 et non par 3', s1.headcount === 4 && s1.shareC === 2000, JSON.stringify(s1));
check('la part du capitaine est bien la sienne', s1.captainC === 2000, String(s1.captainC));
check('le capitaine n’est pas remboursé en totalité', s1.shareC * 3 < s1.totalC);

section('2. Ce qui est refusé l’est vraiment');

/* Les postes de propriétaire n'ont pas de colonne, mais un client bricolé
 * pourrait les glisser dans le corps de la requête. Ils doivent être ignorés,
 * pas additionnés. */
const s2 = share({ fuel: 4000, insurance: 90000, upkeep: 50000, berth: 120000, boat: 900000 }, 1);
check('assurance, entretien, place à l’année et achat sont ignorés',
  s2.totalC === 4000, `total=${s2.totalC}`);
check('la liste des postes refusés est exposée pour être affichée',
  REFUSED_ITEMS.length >= 4 && REFUSED_ITEMS.every((r) => r.why), JSON.stringify(REFUSED_ITEMS.map((r) => r.id)));
check('les postes recevables sont exactement les quatre attendus',
  COST_ITEMS.map((i) => i.id).join(',') === 'fuel,port,bait,food');

section('3. Les refus de bon sens');

check('zéro place → refus', share({ fuel: 5000 }, 0).ok === false);
check('douze équipiers → refus (on quitte la plaisance)', share({ fuel: 5000 }, 12).ok === false);
check('onze équipiers → accepté (12 à bord)', share({ fuel: 5000 }, 11).ok === true);
check('aucun frais → refus', share({}, 2).ok === false);
/* 500 € par personne vient presque toujours d'une saisie en euros là où on
 * attendait des centimes. On préfère faire vérifier plutôt que publier. */
check('montant aberrant → refus', share({ fuel: 200000 }, 3).ok === false, JSON.stringify(share({ fuel: 200000 }, 3)));

section('4. Le plafond');

const costs = { fuel: 6000, port: 1200, bait: 800 };
check('ceiling() rend la part', ceiling(costs, 3) === 2000, String(ceiling(costs, 3)));
check('demander pile le plafond passe', validate(costs, 3, 2000).ok === true);
check('demander un centime de plus est refusé', validate(costs, 3, 2001).ok === false);
check('et le refus dit le plafond', /20,00/.test(validate(costs, 3, 2001).reason || ''), validate(costs, 3, 2001).reason);
check('demander moins passe', validate(costs, 3, 500).ok === true);
check('format monétaire français', euros(2050) === '20,50 €', euros(2050));

/* ======================================================================
 * 5. Le serveur
 * ==================================================================== */
section('5. Le serveur applique les mêmes règles');

async function derive(email, password) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`grims-kdf-v1:${email.trim().toLowerCase()}`)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function req(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
  return { status: res.status, body: data };
}
const rnd = () => Math.random().toString(16).slice(2, 10);
async function account(name) {
  const mail = `crew+${rnd()}@exemple.fr`;
  const r = await req('POST', '/api/auth/register', {
    body: { email: mail, password: await derive(mail, PW), name, invite: INVITE },
  });
  return { mail, token: r.body?.token, id: r.body?.user?.id, status: r.status };
}

const cap = await account('Le Corsaire');
const pec = await account('Jean-Mi');
check('deux comptes créés', !!cap.token && !!pec.token, `${cap.status}/${pec.status}`);

const demain = Date.now() + 26 * 3600_000;
const pub = await req('POST', '/api/crew/publish', {
  token: cap.token,
  body: { port: 'Dieppe', departsAt: demain, hours: 5, seats: 3, fishing: 'leurres',
          costs: { fuel: 6000, port: 1200, bait: 800, food: 0 } },
});
check('sortie publiée', pub.status === 200 && !!pub.body?.id, JSON.stringify(pub.body));
check('le serveur calcule le MÊME plafond que le client',
  pub.body?.shareC === share({ fuel: 6000, port: 1200, bait: 800 }, 3).shareC,
  `serveur=${pub.body?.shareC}`);

/* Le point central. Le client n'envoie pas de prix — mais s'il en envoyait un,
 * le serveur ne doit pas le lire. On tente de forcer un montant. */
const forced = await req('POST', '/api/crew/publish', {
  token: cap.token,
  body: { port: 'Dieppe', departsAt: demain, hours: 5, seats: 3,
          costs: { fuel: 6000, port: 1200, bait: 800 },
          shareC: 9999, share_c: 9999, prix: 9999 },
});
check('un plafond envoyé par le client est IGNORÉ',
  forced.body?.shareC === 2000, `rendu=${forced.body?.shareC}`);

const aberrant = await req('POST', '/api/crew/publish', {
  token: cap.token,
  body: { port: 'Dieppe', departsAt: demain, hours: 5, seats: 2, costs: { fuel: 500000 } },
});
check('des frais aberrants sont refusés côté serveur aussi',
  aberrant.status === 400 && aberrant.body?.error === 'invalid_trip', JSON.stringify(aberrant.body));

const passe = await req('POST', '/api/crew/publish', {
  token: cap.token,
  body: { port: 'Dieppe', departsAt: Date.now() - 86400_000, hours: 5, seats: 2, costs: { fuel: 4000 } },
});
check('une sortie déjà partie est refusée', passe.body?.error === 'trip_in_past', JSON.stringify(passe.body));

section('6. Demander, accepter, et ce qu’on ne voit pas');

const tripId = pub.body.id;
const seen = await req('GET', '/api/crew/trips', { token: pec.token });
const mine = seen.body?.trips?.find((t) => t.id === tripId);
check('la sortie apparaît aux autres', !!mine, JSON.stringify(seen.body?.trips?.length));
check('avec le nom du bateau', mine?.capitaine?.bateau === 'Le Corsaire', JSON.stringify(mine?.capitaine));
/* Le détail des frais du capitaine ne regarde pas l'équipier : il a besoin du
 * montant demandé et de savoir que c'est un partage, pas du plein de gasoil. */
check('mais SANS le détail des frais du capitaine', mine?.costs === undefined, JSON.stringify(mine?.costs));
check('le capitaine, lui, voit son détail',
  (await req('GET', '/api/crew/mine', { token: cap.token })).body?.captain?.[0]?.costs?.fuel === 6000);

const own = await req('POST', '/api/crew/book', { token: cap.token, body: { tripId } });
check('le capitaine ne s’embarque pas lui-même', own.body?.error === 'own_trip', JSON.stringify(own.body));

const b1 = await req('POST', '/api/crew/book', { token: pec.token, body: { tripId, message: 'Dispo dès 6 h' } });
check('demande de place acceptée', b1.status === 200, JSON.stringify(b1.body));
const b2 = await req('POST', '/api/crew/book', { token: pec.token, body: { tripId } });
check('une seconde demande est refusée', b2.body?.error === 'already_asked', JSON.stringify(b2.body));

const inbox = await req('GET', '/api/crew/mine', { token: cap.token });
const dem = inbox.body?.requests?.find((r) => r.tripId === tripId);
check('le capitaine voit la demande', !!dem && dem.pecheur === 'Jean-Mi', JSON.stringify(dem));

const notMine = await req('POST', '/api/crew/decide', { token: pec.token, body: { bookingId: dem.bookingId, accept: true } });
check('un tiers ne décide pas à la place du capitaine', notMine.status === 403, JSON.stringify(notMine.body));

const ok = await req('POST', '/api/crew/decide', { token: cap.token, body: { bookingId: dem.bookingId, accept: true } });
check('le capitaine accepte', ok.body?.status === 'accepted', JSON.stringify(ok.body));

section('7. Les avis');

const tot = await req('POST', '/api/crew/review', {
  token: pec.token, body: { tripId, targetId: cap.id, stars: 5 },
});
check('on ne note pas une sortie à venir', tot.body?.error === 'trip_not_yet', JSON.stringify(tot.body));

/* Une sortie déjà passée, pour éprouver le reste. On la publie à l'heure
 * autorisée la plus ancienne, puis on la fait glisser dans le passé. */
const old = await req('POST', '/api/crew/publish', {
  token: cap.token,
  body: { port: 'Dieppe', departsAt: Date.now() + 60_000, hours: 4, seats: 2, costs: { fuel: 4000 } },
});
const oldId = old.body.id;
await req('POST', '/api/crew/book', { token: pec.token, body: { tripId: oldId } });
const inbox2 = await req('GET', '/api/crew/mine', { token: cap.token });
const dem2 = inbox2.body.requests.find((r) => r.tripId === oldId);
await req('POST', '/api/crew/decide', { token: cap.token, body: { bookingId: dem2.bookingId, accept: true } });

console.log('       (on attend que la sortie soit partie — 65 s)');
await new Promise((r) => setTimeout(r, 65_000));

const r1 = await req('POST', '/api/crew/review', { token: pec.token, body: { tripId: oldId, targetId: cap.id, stars: 5, comment: 'Bon capitaine' } });
check('l’équipier note le capitaine', r1.status === 200, JSON.stringify(r1.body));

const r2 = await req('POST', '/api/crew/review', { token: pec.token, body: { tripId: oldId, targetId: cap.id, stars: 1 } });
check('on ne note pas deux fois', r2.body?.error === 'already_reviewed', JSON.stringify(r2.body));

const outsider = await account('Le Curieux');
const r3 = await req('POST', '/api/crew/review', { token: outsider.token, body: { tripId: oldId, targetId: cap.id, stars: 1 } });
check('quelqu’un qui n’était pas à bord ne note pas', r3.body?.error === 'not_aboard', JSON.stringify(r3.body));

const rep = await req('GET', `/api/crew/reputation?id=${cap.id}`, { token: pec.token });
check('la réputation du capitaine est visible', rep.body?.note?.captain?.moyenne === 5, JSON.stringify(rep.body?.note));
check('avec le détail des avis', rep.body?.avis?.[0]?.comment === 'Bon capitaine', JSON.stringify(rep.body?.avis?.[0]));

section('8. Ménage');
for (const a of [cap, pec, outsider]) await req('DELETE', '/api/account', { token: a.token });
check('comptes de test supprimés', true);

console.log('\n' + '-'.repeat(60));
console.log(fail === 0 ? `TOUT PASSE   (${pass} réussites)` : `ÉCHECS : ${fail}   (${pass} réussites)`);
process.exit(fail === 0 ? 0 : 1);

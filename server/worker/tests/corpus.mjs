/* ==========================================================================
 * tests/corpus.mjs — le fonds de données vu par l'administration
 * --------------------------------------------------------------------------
 *   node tests/corpus.mjs [base] [code-invitation] [email-admin]
 *
 * Ce que cette recette cherche à prendre en défaut :
 *
 *   1. l'extraction se fait-elle vraiment côté SQLite — `->>` et `json_each`
 *      rendent-ils des nombres et non des chaînes, et une seule ligne de JSON
 *      abîmée fait-elle tomber toute la carte ?
 *   2. les filtres filtrent-ils réellement (fenêtre, dates, espèce, compte) ou
 *      rendent-ils tout en donnant l'illusion de filtrer ?
 *   3. une réponse tronquée le DIT-elle ?
 *   4. l'export parcourt-il TOUT le fonds sans répéter ni omettre — c'est le
 *      point qui décide si un modèle s'entraîne sur le corpus ou sur un trou ;
 *   5. l'export laisse-t-il fuir une adresse ?
 *   6. un compte ordinaire peut-il lire le fonds des autres ?
 *
 * Comme les autres recettes : comptes tirés au hasard, supprimés à la fin,
 * rien d'existant n'est touché.
 * ========================================================================== */

import { readFile } from 'node:fs/promises';

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const INVITE = process.argv[3] || 'marée-basse-2026';
const ADMIN_MAIL = process.argv[4] || 'chef@exemple.fr';
const PW = 'motdepasse';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  ÉCHEC ' + l + (d ? '  — ' + d : '')); }
};
const section = (t) => console.log('\n' + t);

async function derive(email, password) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(`grims-kdf-v1:${email.trim().toLowerCase()}`)),
  );
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, key, 256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function req(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  return { status: res.status, body: data };
}

const rnd = () => Math.random().toString(16).slice(2, 10);

async function account(mail, name) {
  return req('POST', '/api/auth/register', {
    body: { email: mail, password: await derive(mail, PW), name, invite: INVITE },
  });
}

/* ==========================================================================
 * Des prises qui ressemblent à de vraies prises
 * --------------------------------------------------------------------------
 * Le relevé de conditions (`snapshot`) est ce qui fait la valeur du corpus :
 * sans marée ni vent, une prise n'est qu'un point. La recette en pose donc un,
 * et vérifie plus loin qu'il ressort — c'est lui qui distingue une ligne
 * « exploitable » d'une ligne simplement « située ».
 * ========================================================================== */
const JOUR = 86400000;
const T0 = Date.parse('2026-06-01T06:00:00Z');

function prise(i, { espece, lat, lon, t, situee = true, avecReleve = true }) {
  return {
    collection: 'catches',
    id: `c-test-${i}`,
    updatedAt: t,
    deleted: false,
    data: {
      id: `c-test-${i}`,
      t,
      speciesId: espece,
      speciesName: espece === 'bar' ? 'Bar' : 'Maquereau',
      count: 1,
      released: i % 3 === 0,
      lengthCm: 40 + (i % 15),
      lat: situee ? lat : null,
      lon: situee ? lon : null,
      snapshot: avecReleve
        ? { heightM: 4.2, coefficient: 78, windSpeedKn: 12.5, windDirDeg: 240, waterDepthM: 18.5 }
        : {},
    },
  };
}

/* ====================================================================== */
section('1. Mise en place');

const adminAcc = await account(ADMIN_MAIL.replace('@', `+${rnd()}@`), 'Bateau chef');
// L'administrateur est reconnu par SON adresse : on se connecte à celle-ci.
let adminTok = null;
{
  const r = await req('POST', '/api/auth/login', {
    body: { email: ADMIN_MAIL, password: await derive(ADMIN_MAIL, PW) },
  });
  if (r.status === 200) adminTok = r.body.token;
  else {
    const c = await account(ADMIN_MAIL, 'Bateau chef');
    adminTok = c.body?.token;
  }
}
check('administrateur connecté', !!adminTok);
const meAdmin = await req('GET', '/api/me', { token: adminTok });
check('/api/me le reconnaît administrateur', meAdmin.body?.admin === true, JSON.stringify(meAdmin.body));

const aMail = `pa+${rnd()}@exemple.fr`;
const bMail = `pb+${rnd()}@exemple.fr`;
const a = await account(aMail, 'La Mouette');
const b = await account(bMail, 'Le Goéland');
check('deux pêcheurs créés', a.status === 200 && b.status === 200);
const aTok = a.body.token, bTok = b.body.token;
const aId = a.body.user.id, bId = b.body.user.id;

/* --- Ce que chacun dépose ---------------------------------------------- */
const changesA = [];
// 12 bars devant Dieppe, un par jour.
for (let i = 0; i < 12; i++) {
  changesA.push(prise(i, { espece: 'bar', lat: 49.95 + i * 0.001, lon: 1.05, t: T0 + i * JOUR }));
}
// Une prise SANS position : elle ne doit jamais apparaître sur la carte.
changesA.push(prise(99, { espece: 'bar', lat: 0, lon: 0, t: T0, situee: false }));
// Une prise SANS relevé de conditions : située, mais pas exploitable.
changesA.push(prise(98, { espece: 'bar', lat: 49.97, lon: 1.06, t: T0, avecReleve: false }));

changesA.push({
  collection: 'soundings', id: 'soundings', updatedAt: T0, deleted: false,
  data: [
    { id: 's1', lat: 49.941, lon: 1.061, t: T0, rawM: 18.2, tideM: 3.1, zeroM: 15.1, tideTrust: 'high' },
    { id: 's2', lat: 49.942, lon: 1.062, t: T0, rawM: 22.4, tideM: 3.1, zeroM: 19.3, tideTrust: 'med' },
    { id: 's3', lat: 49.943, lon: 1.063, t: T0, rawM: 9.9, tideM: null, zeroM: null, tideTrust: 'none' },
  ],
});
changesA.push({
  collection: 'spots', id: 'p-test-1', updatedAt: T0, deleted: false,
  data: { id: 'p-test-1', name: 'Le Ridin', lat: 49.98, lon: 1.02, createdAt: T0, radiusM: 200, depthM: 17 },
});

const pushA = await req('POST', '/api/sync/push', { token: aTok, body: { changes: changesA } });
check('dépôt du premier pêcheur accepté', pushA.status === 200, JSON.stringify(pushA.body));

// Le second pêche loin, et du maquereau : de quoi éprouver les filtres.
const changesB = [];
for (let i = 0; i < 7; i++) {
  changesB.push(prise(200 + i, { espece: 'maquereau', lat: 50.35, lon: 0.60, t: T0 + 60 * JOUR + i * JOUR }));
}
const pushB = await req('POST', '/api/sync/push', { token: bTok, body: { changes: changesB } });
check('dépôt du second pêcheur accepté', pushB.status === 200, JSON.stringify(pushB.body));

/* ====================================================================== */
section('2. Un compte ordinaire ne lit pas le fonds');

for (const route of ['points?kind=catches', 'stats', 'export', 'user?id=' + bId]) {
  const r = await req('GET', `/api/admin/corpus/${route}`, { token: aTok });
  check(`/${route.split('?')[0]} refusé à un pêcheur → 403`, r.status === 403, `reçu ${r.status}`);
}

/* ====================================================================== */
section('3. La carte des prises');

const pts = await req('GET', '/api/admin/corpus/points?kind=catches&limit=5000', { token: adminTok });
check('la carte répond', pts.status === 200, JSON.stringify(pts.body).slice(0, 200));
const mine = (pts.body?.points || []).filter((p) => p.uid === aId || p.uid === bId);
check('les prises des DEUX comptes sont là', mine.length === 12 + 1 + 7, `${mine.length} points`);

const sansPos = mine.filter((p) => p.lat == null || p.lon == null);
check('aucune prise sans position sur la carte', sansPos.length === 0, `${sansPos.length} intrus`);

/* Le point qui décide de tout le reste : si `->>` rendait des chaînes, les
 * comparaisons de fenêtre plus bas seraient lexicographiques et fausses. */
const p0 = mine[0];
check('lat et lon sortent en NOMBRES, pas en chaînes',
  typeof p0.lat === 'number' && typeof p0.lon === 'number', `${typeof p0.lat}/${typeof p0.lon}`);
check('l’horodatage aussi', typeof p0.t === 'number', typeof p0.t);
check('le relevé de conditions ressort', mine.some((p) => p.maree === 4.2 && p.coef === 78));
check('l’espèce et le nom ressortent', mine.some((p) => p.sp === 'bar' && p.spn === 'Bar'));

/* ====================================================================== */
section('4. Les filtres filtrent vraiment');

const boxDieppe = await req(
  'GET', '/api/admin/corpus/points?kind=catches&bbox=49.9,0.9,50.1,1.2&limit=5000', { token: adminTok });
const dansBoite = (boxDieppe.body?.points || []).filter((p) => p.uid === aId || p.uid === bId);
check('la fenêtre exclut le pêcheur du large',
  dansBoite.length === 13 && !dansBoite.some((p) => p.uid === bId), `${dansBoite.length} points`);
check('et ne garde que ce qui est dans la boîte',
  dansBoite.every((p) => p.lat >= 49.9 && p.lat <= 50.1 && p.lon >= 0.9 && p.lon <= 1.2));

const parEspece = await req(
  'GET', '/api/admin/corpus/points?kind=catches&species=maquereau&limit=5000', { token: adminTok });
const maq = (parEspece.body?.points || []).filter((p) => p.uid === aId || p.uid === bId);
check('le filtre d’espèce ne rend que du maquereau',
  maq.length === 7 && maq.every((p) => p.sp === 'maquereau'), `${maq.length} points`);

const parCompte = await req(
  `GET`, `/api/admin/corpus/points?kind=catches&user=${bId}&limit=5000`, { token: adminTok });
check('le filtre par compte isole un pêcheur',
  (parCompte.body?.points || []).length === 7
  && parCompte.body.points.every((p) => p.uid === bId));

const depuis = T0 + 30 * JOUR;
const parDate = await req(
  `GET`, `/api/admin/corpus/points?kind=catches&from=${depuis}&limit=5000`, { token: adminTok });
const recents = (parDate.body?.points || []).filter((p) => p.uid === aId || p.uid === bId);
check('la fenêtre de dates écarte les anciennes prises',
  recents.length === 7 && recents.every((p) => p.t >= depuis), `${recents.length} points`);

/* ====================================================================== */
section('5. Une réponse tronquée le dit');

const court = await req('GET', '/api/admin/corpus/points?kind=catches&limit=3', { token: adminTok });
check('la limite est respectée', (court.body?.points || []).length === 3);
check('et la troncature est ANNONCÉE', court.body?.tronque === true, JSON.stringify(court.body?.tronque));

/* ====================================================================== */
section('6. Les sondes, éclatées depuis leur blob');

const sondes = await req('GET', '/api/admin/corpus/points?kind=soundings&limit=5000', { token: adminTok });
const mesSondes = (sondes.body?.points || []).filter((p) => p.uid === aId);
check('les trois sondes du carnet sortent en TROIS points', mesSondes.length === 3, `${mesSondes.length}`);
check('avec leur profondeur ramenée au zéro', mesSondes.some((s) => s.zero === 15.1));
check('la sonde non corrigée sort quand même, avec zéro nul',
  mesSondes.some((s) => s.zero === null && s.brut === 9.9));

const marques = await req('GET', '/api/admin/corpus/points?kind=spots&limit=5000', { token: adminTok });
check('la marque personnelle sort',
  (marques.body?.points || []).some((m) => m.uid === aId && m.nom === 'Le Ridin'));

const inconnu = await req('GET', '/api/admin/corpus/points?kind=nimportequoi', { token: adminTok });
check('un type inconnu → 400', inconnu.status === 400, `reçu ${inconnu.status}`);

/* ====================================================================== */
section('7. Les chiffres du corpus');

const st = await req('GET', '/api/admin/corpus/stats', { token: adminTok });
check('les statistiques répondent', st.status === 200);
check('« situées » est inférieur au total — la prise sans GPS est comptée à part',
  st.body.prises.situees < st.body.prises.total);
check('« exploitables » est inférieur à « situées » — la prise sans relevé aussi',
  st.body.prises.exploitables < st.body.prises.situees,
  `${st.body.prises.exploitables} / ${st.body.prises.situees}`);
check('le bar est dans le décompte des espèces',
  st.body.especes.some((e) => e.id === 'bar' && e.n >= 12));
check('avec une taille moyenne', st.body.especes.find((e) => e.id === 'bar')?.tailleMoyCm > 0);
check('les sondes sont comptées', st.body.sondes.total >= 3);
check('les corrigées le sont à part', st.body.sondes.corrigees < st.body.sondes.total);
check('le rythme mensuel est rendu', Array.isArray(st.body.mois) && st.body.mois.length >= 1);
check('les mois ont la forme AAAA-MM', /^\d{4}-\d{2}$/.test(st.body.mois[0].mois), st.body.mois[0]?.mois);
check('aucune adresse dans les statistiques', !JSON.stringify(st.body).includes('@'));

/* ====================================================================== */
section('8. Le détail d’un compte');

const det = await req(`GET`, `/api/admin/corpus/user?id=${aId}`, { token: adminTok });
check('le détail répond', det.status === 200);
check('il nomme le bateau', det.body?.compte?.bateau === 'La Mouette');
check('il compte les prises', det.body?.prises?.n === 14, String(det.body?.prises?.n));
check('il compte les sondes du carnet', det.body?.sondes === 3, String(det.body?.sondes));
check('il liste les espèces du compte', det.body?.especes?.some((e) => e.nom === 'Bar'));
const absent = await req('GET', '/api/admin/corpus/user?id=u_inexistant', { token: adminTok });
check('un compte inconnu → 404', absent.status === 404, `reçu ${absent.status}`);

/* ====================================================================== */
section('9. L’export parcourt TOUT, sans répéter ni omettre');

/* Le vrai piège de cette route. Le curseur porte sur (user_id, rec_id) et non
 * sur `seq`, qui est monotone par COMPTE : un curseur global sur `seq` aurait
 * sauté des lignes en silence. On le prend en défaut en forçant des tranches
 * plus petites que le fonds, et en comptant les identifiants distincts. */
const vus = new Map();
let tours = 0, curseur = null;
do {
  const q = curseur
    ? `?limit=4&afterUser=${encodeURIComponent(curseur.user)}&afterRec=${encodeURIComponent(curseur.rec)}`
    : '?limit=4';
  const page = await req('GET', `/api/admin/corpus/export${q}`, { token: adminTok });
  if (page.status !== 200) { check('export : page lue', false, JSON.stringify(page.body)); break; }
  for (const l of page.body.lignes) vus.set(`${l.user}/${l.id}`, (vus.get(`${l.user}/${l.id}`) || 0) + 1);
  curseur = page.body.suivant;
  tours++;
} while (curseur && tours < 200);

const miennes = [...vus.keys()].filter((k) => k.startsWith(aId) || k.startsWith(bId));
check('l’export a bien fallu plusieurs tranches', tours >= 4, `${tours} tranches`);
check('toutes les prises des deux comptes sont ressorties',
  miennes.length === 14 + 7, `${miennes.length} sur 21`);
check('aucune n’est ressortie DEUX fois',
  [...vus.values()].every((n) => n === 1), 'doublons détectés');

const uneTranche = await req('GET', '/api/admin/corpus/export?limit=5000', { token: adminTok });
check('l’export ne porte AUCUNE adresse',
  !JSON.stringify(uneTranche.body).includes('@exemple.fr'));
check('mais bien l’identifiant de compte, qui regroupe sans nommer',
  uneTranche.body.lignes.some((l) => l.user === aId));
check('et le relevé de conditions, sans quoi le corpus n’apprend rien',
  uneTranche.body.lignes.some((l) => String(l.data).includes('"coefficient":78')));

/* ====================================================================== */
section('10. Une ligne de JSON abîmée ne fait pas tomber la carte');

/* On ne peut pas écrire du JSON invalide par l'API — `push` le refuse, et
 * c'est bien. On vérifie donc l'inverse, qui est ce qui compte : la garde
 * `json_valid()` est bien présente sur chaque requête qui déplie du JSON.
 * Sans elle, UN blob tronqué ferait échouer `json_each` pour TOUT LE MONDE. */
const src = await readFile(new URL('../src/corpus.js', import.meta.url), 'utf8').catch(() => null);
if (src) {
  const deplient = src.split('json_each(').length - 1;
  const gardes = src.split('json_valid(').length - 1;
  check('chaque requête qui déplie du JSON est gardée',
    gardes >= deplient && deplient >= 3, `${gardes} gardes pour ${deplient} json_each`);
} else {
  check('source lisible pour vérifier les gardes', false, 'fichier introuvable');
}

/* ====================================================================== */
section('11. Ménage');

for (const t of [aTok, bTok]) {
  const d = await req('DELETE', '/api/account', { token: t });
  check('compte de test supprimé', d.status === 200);
}

console.log('\n' + '-'.repeat(60));
console.log(fail === 0 ? `TOUT PASSE   (${pass} réussites)` : `ÉCHECS : ${fail}   (${pass} réussites)`);
process.exit(fail === 0 ? 0 : 1);

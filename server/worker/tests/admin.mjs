/* ==========================================================================
 * tests/admin.mjs — administration et suspension
 * --------------------------------------------------------------------------
 *   node tests/admin.mjs [base] [code-invitation] [email-admin]
 *
 * La question qui compte n'est pas « le bouton existe-t-il » mais « la
 * suspension suspend-elle vraiment » : jeton coupé, reconnexion refusée, et
 * pas un mot des données du compte dans la réponse d'administration.
 *
 * Comme la recette PHP, ce test crée ses comptes à des adresses tirées au
 * hasard et les supprime. Il ne touche à rien d'existant.
 * ========================================================================== */

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

/** Le même étirement que le navigateur : le serveur n'accepte rien d'autre. */
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

async function makeAccount(mail, name) {
  return req('POST', '/api/auth/register', {
    body: { email: mail, password: await derive(mail, PW), name, invite: INVITE },
  });
}

/* ====================================================================== */
section('1. Un compte ordinaire n’administre rien');

const userMail = `u+${rnd()}@exemple.fr`;
const user = await makeAccount(userMail, 'Le Corsaire');
check('compte ordinaire créé', user.status === 200 && !!user.body?.token, JSON.stringify(user.body));
const userTok = user.body?.token;

const me = await req('GET', '/api/me', { token: userTok });
check('/api/me le dit non administrateur', me.body?.admin === false, JSON.stringify(me.body));

for (const [m, p] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/users']]) {
  const r = await req(m, p, { token: userTok });
  check(`${p} → 403 forbidden`, r.status === 403 && r.body?.error === 'forbidden', JSON.stringify(r.body));
}
/* 403 et non 401 : le jeton est valide, c'est le DROIT qui manque. Un 401
 * ferait effacer la session — se tromper de route déconnecterait. */
const probe = await req('GET', '/api/admin/overview', { token: userTok });
check('et surtout PAS 401 (sinon la session serait effacée)', probe.status !== 401);

/* ====================================================================== */
section('2. L’administrateur voit qui, jamais quoi');

const admin = await makeAccount(ADMIN_MAIL, 'Amirauté').catch(() => null);
let adminTok = admin?.body?.token;
if (!adminTok) {
  const r = await req('POST', '/api/auth/login', {
    body: { email: ADMIN_MAIL, password: await derive(ADMIN_MAIL, PW) },
  });
  adminTok = r.body?.token;
}
check('compte administrateur disponible', !!adminTok);

const meA = await req('GET', '/api/me', { token: adminTok });
check('/api/me le reconnaît administrateur', meA.body?.admin === true, JSON.stringify(meA.body));

const ov = await req('GET', '/api/admin/overview', { token: adminTok });
check('vue d’ensemble accessible', ov.status === 200 && typeof ov.body?.users?.total === 'number', JSON.stringify(ov.body));
check('elle compte au moins nos deux comptes', (ov.body?.users?.total || 0) >= 2);

/* Le compte ordinaire dépose une marque. Elle ne doit apparaître NULLE PART
 * dans les réponses d'administration — c'est la règle de tout le projet. */
await req('POST', '/api/sync/push', {
  token: userTok,
  body: { changes: [{
    collection: 'spots', id: 'secret1', updatedAt: Date.now(), deleted: false,
    data: { id: 'secret1', nom: 'LE-COIN-A-BARS-SECRET', lat: 49.9312, lon: 1.0781 },
  }] },
});

const list = await req('GET', '/api/admin/users?limit=200', { token: adminTok });
const row = list.body?.users?.find((u) => u.email === userMail);
check('la liste montre le compte', !!row, JSON.stringify(list.body?.users?.length));
check('avec le nom du bateau', row?.bateau === 'Le Corsaire', JSON.stringify(row));
check('et le nombre d’enregistrements', row?.enregistrements >= 1, JSON.stringify(row?.enregistrements));

const dump = JSON.stringify(list.body) + JSON.stringify(ov.body);
check('AUCUNE donnée de compte ne fuit dans l’administration',
  !dump.includes('LE-COIN-A-BARS-SECRET') && !dump.includes('49.93'), 'une marque est apparue dans la réponse');

/* ====================================================================== */
section('3. Suspendre suspend vraiment');

const sus = await req('POST', '/api/admin/suspend', {
  token: adminTok, body: { id: row.id, suspended: true, reason: 'essai automatisé' },
});
check('suspension acceptée', sus.status === 200 && sus.body?.suspendu === true, JSON.stringify(sus.body));

/* Le point central. Sans coupure des jetons, l'appareil déjà connecté
 * continuerait de synchroniser quatre-vingt-dix jours durant — une suspension
 * qui ne suspend rien. */
const after = await req('GET', '/api/sync/pull?since=0', { token: userTok });
check('le jeton du compte suspendu ne vaut plus rien',
  after.status === 403 && after.body?.error === 'account_suspended', JSON.stringify(after.body));

const relog = await req('POST', '/api/auth/login', {
  body: { email: userMail, password: await derive(userMail, PW) },
});
check('et il ne peut pas se reconnecter',
  relog.status === 403 && relog.body?.error === 'account_suspended', JSON.stringify(relog.body));

const selfSus = await req('POST', '/api/admin/suspend', {
  token: adminTok, body: { id: meA.body.id, suspended: true },
});
check('l’administrateur ne peut pas se suspendre lui-même',
  selfSus.body?.error === 'cannot_suspend_self', JSON.stringify(selfSus.body));

/* ====================================================================== */
section('4. Réactiver rend l’accès, et les données sont intactes');

const un = await req('POST', '/api/admin/suspend', {
  token: adminTok, body: { id: row.id, suspended: false },
});
check('réactivation acceptée', un.status === 200 && un.body?.suspendu === false, JSON.stringify(un.body));

const relog2 = await req('POST', '/api/auth/login', {
  body: { email: userMail, password: await derive(userMail, PW) },
});
check('le compte se reconnecte', relog2.status === 200 && !!relog2.body?.token, JSON.stringify(relog2.body));

const back = await req('GET', '/api/sync/pull?since=0', { token: relog2.body?.token });
const spot = back.body?.records?.find((r) => r.id === 'secret1');
check('sa marque est toujours là — suspendre ne détruit rien',
  spot?.data?.nom === 'LE-COIN-A-BARS-SECRET', JSON.stringify(back.body?.records?.length));

/* ====================================================================== */
section('5. Ménage');
const d1 = await req('DELETE', '/api/account', { token: relog2.body?.token });
check('compte de test supprimé', d1.status === 200);

console.log('\n' + '-'.repeat(60));
console.log(fail === 0 ? `TOUT PASSE   (${pass} réussites)` : `ÉCHECS : ${fail}   (${pass} réussites)`);
process.exit(fail === 0 ? 0 : 1);

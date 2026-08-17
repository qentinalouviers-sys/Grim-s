/* ==========================================================================
 * auth.js — comptes, jetons, limitation de débit
 * --------------------------------------------------------------------------
 * LE POINT LE PLUS IMPORTANT DE CE FICHIER
 *
 * L'offre gratuite de Workers accorde 10 ms de temps processeur par requête.
 * Un hachage de mot de passe correct est coûteux PAR CONSTRUCTION : c'est même
 * toute sa fonction. Mesuré ici, en PBKDF2-SHA256 :
 *
 *      10 000 itérations →  6,5 ms      (déjà au bord des 10 ms)
 *      25 000            → 12,0 ms      (dépassé)
 *     210 000            → 95,0 ms
 *     600 000            → 273,0 ms     (la recommandation courante)
 *
 * Autrement dit : sur cette plateforme, on ne peut pas à la fois rester dans
 * le budget et hacher correctement. Baisser le nombre d'itérations pour tenir
 * dans les 10 ms reviendrait à publier des mots de passe à peine protégés —
 * et ce sont des mots de passe que leurs propriétaires réutilisent à la banque
 * et sur leur messagerie.
 *
 * D'où le choix retenu : **l'étirement se fait dans le navigateur.**
 * Le client dérive `clé = PBKDF2(mot de passe, sel, 600 000)` et n'envoie que
 * cette clé. Le serveur ne voit jamais le mot de passe, et se contente d'un
 * PBKDF2 court par-dessus, avec un sel aléatoire propre au compte.
 *
 * Ce que cela donne face à une copie volée de la base : pour chaque mot de
 * passe candidat, l'attaquant doit refaire les 600 000 itérations du client.
 * Le facteur de travail est donc celui qui est recommandé — il a simplement
 * changé de machine. Et l'empreinte volée ne permet pas de se connecter :
 * l'authentification exige la clé, pas son empreinte.
 *
 * Ce raisonnement ne tient QUE si le client étire vraiment. Un client qui
 * enverrait le mot de passe en clair le verrait stocké derrière un PBKDF2
 * court, c'est-à-dire presque à nu. On ne l'espère donc pas : `assertStretched`
 * l'impose, et refuse tout ce qui n'a pas la forme exacte d'une clé dérivée.
 * ========================================================================== */

import { fail, bearer, clientIp, hex, sha256Hex, timingSafeEqual } from './http.js';

const TOKEN_TTL = 90 * 86400; // secondes
const RESET_TTL = 3600;

const RL_WINDOW = 60;
const RL_MAX = 5;

/** Itérations appliquées PAR LE SERVEUR, par-dessus celles du client. */
const SERVER_ITER = 1000;

/** Forme d'une clé dérivée : 256 bits en hexadécimal minuscule. */
const KEY_RE = /^[0-9a-f]{64}$/;

/* ==========================================================================
 * Hachage
 * ========================================================================== */

/**
 * Impose que ce qui arrive soit bien une clé dérivée, et non un mot de passe.
 *
 * C'est une barrière, pas une vérification de confort : sans elle, un client
 * ancien ou bricolé ferait stocker un vrai mot de passe derrière un PBKDF2 de
 * mille tours, et personne ne s'en apercevrait avant la fuite.
 */
function assertStretched(value) {
  if (typeof value !== 'string' || !KEY_RE.test(value)) fail('client_outdated', 400);
}

async function derive(keyHex, saltHex, iterations = SERVER_ITER) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyHex),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const salt = Uint8Array.from(saltHex.match(/../g).map((b) => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return hex(bits);
}

/** Format stocké : `pbkdf2$<itérations>$<sel>$<empreinte>`, tout en hexa. */
async function hashKey(keyHex) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${SERVER_ITER}$${salt}$${await derive(keyHex, salt)}`;
}

async function verifyKey(keyHex, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 100_000) return false;
  return timingSafeEqual(await derive(keyHex, parts[2], iterations), parts[3]);
}

/* ==========================================================================
 * Limitation de débit
 * ========================================================================== */

async function throttle(env, request, action) {
  const now = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);

  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM attempts WHERE ip = ?1 AND action = ?2 AND at > ?3',
  )
    .bind(ip, action, now - RL_WINDOW)
    .first();

  if ((row?.n || 0) >= RL_MAX) fail('rate_limited', 429);

  await env.DB.prepare('INSERT INTO attempts (ip, action, at) VALUES (?1, ?2, ?3)')
    .bind(ip, action, now)
    .run();

  /* Purge opportuniste : sans elle la table grossit sans fin. Une fois sur
   * cinquante suffit — ce n'est pas une donnée qu'on regrette. */
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM attempts WHERE at < ?1').bind(now - 3600).run();
  }
}

/* ==========================================================================
 * Jetons
 * ========================================================================== */

/**
 * Le jeton part en clair vers le client ; la base n'en garde que l'empreinte.
 * Une copie de la table `tokens` ne permet donc de se connecter à aucun
 * compte — c'est la règle qui interdit de stocker un mot de passe en clair,
 * appliquée à ce qui en tient lieu.
 */
async function issueToken(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO tokens (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(await sha256Hex(token), userId, now, now + TOKEN_TTL, now)
    .run();
  return token;
}

/**
 * Identifie l'appelant, ou lève un 401.
 *
 * Le 401 a un sens précis côté client : il efface la session locale et affiche
 * « session expirée ». Il ne doit donc sortir que d'ici — pour un jeton
 * invalide, expiré ou révoqué. Un 401 rendu sur un corps mal formé
 * déconnecterait l'utilisateur sans raison.
 */
export async function requireUser(request, env) {
  const token = bearer(request);
  if (!token) fail('unauthorized', 401);

  const row = await env.DB.prepare(
    `SELECT t.token_hash, t.expires_at, t.last_used_at, u.id, u.email, u.name
       FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first();

  if (!row) fail('unauthorized', 401);

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?1').bind(row.token_hash).run();
    fail('unauthorized', 401);
  }

  /* Prolongation glissante. Un jeton d'une heure obligerait à se reconnecter
   * en mer, sans réseau, avec les mains mouillées — précisément le moment où
   * l'app doit se contenter de fonctionner. On ne réécrit pas à chaque appel. */
  if (now - row.last_used_at > 86400) {
    await env.DB.prepare('UPDATE tokens SET last_used_at = ?1, expires_at = ?2 WHERE token_hash = ?3')
      .bind(now, now + TOKEN_TTL, row.token_hash)
      .run();
  }

  return { id: row.id, email: row.email, name: row.name };
}

/* ==========================================================================
 * Routes
 * ========================================================================== */

const emailOk = (e) =>
  typeof e === 'string' && e.length <= 190 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ==========================================================================
 * Qui a le droit de créer un compte
 * --------------------------------------------------------------------------
 * Une API ouverte sur Internet dont l'inscription est libre finit par héberger
 * les données de gens qu'on n'a pas invités — sur son quota, et bientôt sur sa
 * carte de flotte. Ils ne peuvent pas lire les données des autres : chaque
 * requête est filtrée par `user_id`, et ce filtre est dans la requête, pas
 * dans une politique d'accès qu'on pourrait oublier de poser. Mais ils
 * occupent la place.
 *
 * `INVITE_CODE` ferme la porte. Vide, l'inscription reste ouverte — c'est le
 * comportement d'avant, conservé pour ne pas casser une installation qui
 * marche. Renseigné, il faut le présenter.
 *
 * La comparaison est à temps constant : un `===` s'arrête au premier caractère
 * différent, et la durée trahit alors combien de tête est juste. Sur un code
 * qu'on peut essayer en boucle, ça se mesure.
 * ========================================================================== */
function checkInvite(env, body) {
  const expected = String(env.INVITE_CODE || '');
  if (!expected) return;

  const given = String(body.invite || '').trim();
  if (!given) fail('invite_required', 403);
  if (!timingSafeEqual(given, expected)) fail('invite_invalid', 403);
}

export async function register(request, env, body) {
  await throttle(env, request, 'register');
  checkInvite(env, body);

  const email = String(body.email || '').trim();
  const name = body.name == null ? null : String(body.name).trim() || null;

  if (!emailOk(email)) fail('invalid_email', 400);
  assertStretched(body.password);

  const key = email.toLowerCase();

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email_key = ?1').bind(key).first();
  if (existing) fail('email_taken', 409);

  const id = 'u_' + hex(crypto.getRandomValues(new Uint8Array(8)));
  try {
    await env.DB.prepare(
      'INSERT INTO users (id, email, email_key, pass_hash, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
      .bind(id, email, key, await hashKey(body.password), name, Math.floor(Date.now() / 1000))
      .run();
  } catch {
    /* Deux inscriptions simultanées sur la même adresse : l'index unique
     * tranche. Le SELECT ci-dessus ne suffit pas, il y a une fenêtre. */
    fail('email_taken', 409);
  }

  return { token: await issueToken(env, id), user: { id, email, name } };
}

export async function login(request, env, body) {
  await throttle(env, request, 'login');

  const email = String(body.email || '').trim();
  assertStretched(body.password);

  const u = await env.DB.prepare(
    'SELECT id, email, name, pass_hash, fail_count, locked_until FROM users WHERE email_key = ?1',
  )
    .bind(email.toLowerCase())
    .first();

  const now = Math.floor(Date.now() / 1000);
  if (u && u.locked_until > now) fail('account_locked', 423);

  /* Compte inconnu : on vérifie quand même une empreinte factice, pour que la
   * durée de réponse soit la même. Sans cela, répondre en une microseconde sur
   * une adresse inconnue et en plusieurs sur une adresse connue permet de
   * dresser la liste des inscrits sans deviner un seul mot de passe. */
  const stored = u?.pass_hash || `pbkdf2$${SERVER_ITER}$${'00'.repeat(16)}$${'00'.repeat(32)}`;
  const ok = (await verifyKey(body.password, stored)) && !!u;

  if (!ok) {
    if (u) {
      const fails = u.fail_count + 1;
      /* Verrou progressif au-delà de dix échecs. Ça ne gêne pas quelqu'un qui
       * se trompe de doigt, et ça rend l'essai systématique inexploitable. */
      const lock = fails >= 10 ? now + Math.min(900, 30 * (fails - 9)) : 0;
      await env.DB.prepare('UPDATE users SET fail_count = ?1, locked_until = ?2 WHERE id = ?3')
        .bind(fails, lock, u.id)
        .run();
    }
    /* UN SEUL code pour « adresse inconnue » et « mot de passe faux » :
     * distinguer les deux revient à publier qui a un compte. */
    fail('bad_credentials', 401);
  }

  if (u.fail_count !== 0) {
    await env.DB.prepare('UPDATE users SET fail_count = 0, locked_until = 0 WHERE id = ?1')
      .bind(u.id)
      .run();
  }

  return { token: await issueToken(env, u.id), user: { id: u.id, email: u.email, name: u.name } };
}

export async function logout(request, env) {
  const token = bearer(request);
  if (token) {
    await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  }
  /* Pas de 401 sur un jeton déjà mort : se déconnecter deux fois doit réussir
   * deux fois. Le client n'attend pas cette réponse de toute façon. */
  return { ok: true };
}

export async function forgot(request, env, body) {
  await throttle(env, request, 'forgot');

  /* Sans expéditeur configuré, la route existe mais ne peut rien faire. On
   * répond 501, que le client reconnaît et traduit par « pas encore en
   * service » — plutôt qu'une erreur qui ferait chercher une faute de frappe
   * dans l'adresse pendant un quart d'heure. */
  if (!env.MAIL_FROM || !env.PUBLIC_URL || !env.SMTP_URL) fail('not_implemented', 501);

  const email = String(body.email || '').trim();
  const u = await env.DB.prepare('SELECT id, email FROM users WHERE email_key = ?1')
    .bind(email.toLowerCase())
    .first();

  if (u) {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO resets (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(await sha256Hex(token), u.id, now, now + RESET_TTL)
      .run();

    await sendResetMail(env, u.email, `${String(env.PUBLIC_URL).replace(/\/+$/, '')}/reset?t=${token}`);
  }

  /* 200 dans TOUS les cas, compte existant ou non : répondre 404 sur une
   * adresse inconnue transformerait ce formulaire en annuaire. */
  return { ok: true };
}

/**
 * Envoi du courriel par une API HTTP.
 *
 * Un Worker ne peut pas ouvrir de connexion SMTP — il n'a pas de sockets
 * bruts. On passe donc par l'API HTTP d'un service d'envoi. `SMTP_URL` et
 * `SMTP_KEY` sont des secrets ; tant qu'ils sont absents, `forgot` répond 501
 * bien avant d'arriver ici.
 */
async function sendResetMail(env, to, link) {
  const body = {
    sender: { email: env.MAIL_FROM, name: "Grim's Compagnon" },
    to: [{ email: to }],
    subject: "Grim's Compagnon — mot de passe",
    textContent:
      'Bonjour,\n\n' +
      'Une réinitialisation du mot de passe a été demandée pour ce compte.\n' +
      'Ce lien est valable une heure et ne fonctionne qu\'une fois :\n\n' +
      link +
      '\n\nSi vous n\'êtes pas à l\'origine de cette demande, ignorez ce message :\n' +
      'votre mot de passe reste inchangé.\n',
  };

  /* On n'attend pas et on n'échoue pas dessus : que le service d'envoi soit en
   * panne ne doit pas révéler, par un code d'erreur, que ce compte existe. */
  try {
    await fetch(env.SMTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.SMTP_KEY || '' },
      body: JSON.stringify(body),
    });
  } catch {
    /* sans effet */
  }
}

/* ==========================================================================
 * Page de réinitialisation
 * --------------------------------------------------------------------------
 * Servie par le Worker lui-même : c'est une page unique ouverte depuis un lien
 * reçu par courriel, et la PWA n'a pas de routage d'URL profondes pour
 * l'accueillir.
 *
 * Elle porte le même étirement que l'app — sinon le mot de passe changé ici
 * serait dérivé autrement, et la connexion suivante échouerait. C'est pour
 * cela que l'adresse du compte est inscrite dans la page : le sel en dépend.
 * ========================================================================== */

export async function resetPage(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get('t') || '';
  let error = '';
  let done = false;
  let email = '';

  if (request.method === 'POST') {
    const form = await request.formData();
    token = String(form.get('t') || '');
    const key = String(form.get('key') || '');

    const r = await env.DB.prepare(
      'SELECT token_hash, user_id, expires_at, used_at FROM resets WHERE token_hash = ?1',
    )
      .bind(await sha256Hex(token))
      .first();

    if (!KEY_RE.test(key)) {
      error = 'Le navigateur n’a pas pu préparer le mot de passe. Réessayez.';
    } else if (!r || r.used_at !== 0 || r.expires_at < Math.floor(Date.now() / 1000)) {
      error = 'Ce lien a expiré ou a déjà servi. Redemandez-en un depuis l’application.';
    } else {
      await env.DB.prepare('UPDATE users SET pass_hash = ?1, fail_count = 0, locked_until = 0 WHERE id = ?2')
        .bind(await hashKey(key), r.user_id)
        .run();
      await env.DB.prepare('UPDATE resets SET used_at = ?1 WHERE token_hash = ?2')
        .bind(Math.floor(Date.now() / 1000), r.token_hash)
        .run();
      /* Changer de mot de passe déconnecte partout ailleurs. Quelqu'un qui
       * fait cette démarche soupçonne souvent un accès qui n'est pas le sien :
       * laisser vivre les jetons existants viderait la manœuvre de son sens. */
      await env.DB.prepare('DELETE FROM tokens WHERE user_id = ?1').bind(r.user_id).run();
      done = true;
    }
  }

  if (!done && token) {
    const r = await env.DB.prepare(
      `SELECT u.email FROM resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ?1 AND r.used_at = 0 AND r.expires_at > ?2`,
    )
      .bind(await sha256Hex(token), Math.floor(Date.now() / 1000))
      .first();
    email = r?.email || '';
    if (!email && !error) error = 'Ce lien a expiré ou a déjà servi.';
  }

  return new Response(resetHtml({ token, email, error, done }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resetHtml({ token, email, error, done }) {
  const form = done
    ? '<p class="ok">Mot de passe changé. Retournez dans l’application et connectez-vous.</p>'
    : `${error ? `<p class="err">${esc(error)}</p>` : ''}
       ${email ? `<form method="post" id="f">
         <input type="hidden" name="t" value="${esc(token)}">
         <input type="hidden" name="key" id="key">
         <p class="who">${esc(email)}</p>
         <label>Nouveau mot de passe<input type="password" id="p1" autocomplete="new-password" minlength="8" required></label>
         <label>Répétez-le<input type="password" id="p2" autocomplete="new-password" minlength="8" required></label>
         <button type="submit" id="b">Enregistrer</button>
       </form>` : ''}`;

  return `<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grim's Compagnon — mot de passe</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#0b1220;color:#e8eef7;margin:0;display:flex;
align-items:center;justify-content:center;min-height:100vh;padding:24px}
main{max-width:24rem;width:100%}h1{font-size:1.25rem;margin:0 0 1rem}
.who{color:#8fa7c4;margin:0 0 1rem;font-size:.9rem}
label{display:block;margin:0 0 1rem}input{width:100%;box-sizing:border-box;padding:.7rem;margin-top:.35rem;
border-radius:.5rem;border:1px solid #2a3a52;background:#111c2e;color:inherit;font-size:1rem}
button{width:100%;padding:.8rem;border:0;border-radius:.5rem;background:#2f81f7;color:#fff;font-size:1rem}
button[disabled]{opacity:.6}.err{color:#ffb4a2}.ok{color:#9ae6b4}
</style><main><h1>Nouveau mot de passe</h1>${form}</main>
<script>
/* Le même étirement que l'application : le serveur ne doit jamais voir le mot
   de passe, ici pas davantage qu'ailleurs. Si les deux calculs divergeaient,
   le mot de passe changé ici ne permettrait plus de se connecter. */
const EMAIL = ${JSON.stringify(email)};
const f = document.getElementById('f');
if (f) f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
  if (p1.length < 8) return alert('Le mot de passe doit faire au moins huit caractères.');
  if (p1 !== p2) return alert('Les deux mots de passe ne sont pas identiques.');
  const b = document.getElementById('b');
  b.disabled = true; b.textContent = 'Chiffrement…';
  const enc = new TextEncoder();
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('grims-kdf-v1:' + EMAIL.trim().toLowerCase())));
  const k = await crypto.subtle.importKey('raw', enc.encode(p1), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000}, k, 256);
  document.getElementById('key').value = [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('');
  f.submit();
});
</script></html>`;
}

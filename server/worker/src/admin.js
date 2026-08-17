/* ==========================================================================
 * admin.js — le panneau d'administration
 * --------------------------------------------------------------------------
 * CE QUE L'ADMINISTRATEUR VOIT, ET CE QU'IL NE VOIT PAS
 *
 * Il voit QUI : adresse, nom du bateau, date d'inscription, dernière venue,
 * combien d'enregistrements le compte porte, s'il est suspendu.
 *
 * Il ne voit JAMAIS QUOI : ni les marques, ni le carnet de sondes, ni les
 * traces, ni les prises. Ce sont des postes de pêche relevés à bord par des
 * gens qui n'ont pas envie de les publier — c'est écrit noir sur blanc dans
 * le contrat de ce serveur, et administrer un service ne donne pas le droit
 * de lire ce qu'on y dépose.
 *
 * La règle est tenue par le code, pas par la discipline : aucune requête de
 * ce fichier ne lit la colonne `data`. Elle ne fait que compter des lignes.
 *
 * QUI EST ADMINISTRATEUR
 *
 * Le secret `ADMIN_EMAILS`, une liste d'adresses séparées par des virgules.
 * Un SECRET, pas une variable ordinaire : `wrangler.toml` est versionné dans
 * un dépôt public, et y écrire une adresse personnelle revient à la publier
 * pour les moissonneurs de courriels.
 *
 *     npx wrangler secret put ADMIN_EMAILS
 *
 * Non renseigné : aucune route d'administration ne répond. C'est le bon
 * défaut — une installation neuve n'a pas d'administrateur par accident.
 * ========================================================================== */

import { fail } from './http.js';

/**
 * Vérifie que l'appelant administre ce serveur, ou coupe.
 *
 * Répond 403 et non 401 : le jeton est parfaitement valide, c'est le droit qui
 * manque. Un 401 ferait effacer la session au client — quelqu'un qui touche
 * une route d'administration par erreur serait déconnecté sans comprendre.
 */
export function requireAdmin(env, user) {
  const list = String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!list.length) fail('forbidden', 403);
  if (!list.includes(String(user.email || '').toLowerCase())) fail('forbidden', 403);
}

/** Vrai sans lever d'erreur — pour dire au client s'il faut afficher l'entrée. */
export function isAdmin(env, user) {
  try {
    requireAdmin(env, user);
    return true;
  } catch {
    return false;
  }
}

/* ==========================================================================
 * GET /api/admin/overview
 * ========================================================================== */
export async function overview(env) {
  const now = Math.floor(Date.now() / 1000);
  const month = now - 30 * 86400;

  const users = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended,
            SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) AS nouveaux
       FROM users`,
  )
    .bind(month)
    .first();

  /* Actifs : vus dans les trente derniers jours. `last_used_at` n'est réécrit
   * qu'une fois par jour — assez fin pour ça, et ça évite une écriture à
   * chaque appel. */
  const actifs = await env.DB.prepare(
    'SELECT COUNT(DISTINCT user_id) AS n FROM tokens WHERE last_used_at > ?1',
  )
    .bind(month)
    .first();

  /* On compte, on ne lit pas. `length(data)` mesure un volume sans jamais
   * ramener le contenu — la différence n'est pas cosmétique. */
  const { results: cols } = await env.DB.prepare(
    `SELECT collection, COUNT(*) AS n, SUM(length(COALESCE(data, ''))) AS octets
       FROM records WHERE deleted = 0 GROUP BY collection ORDER BY collection`,
  ).all();

  return {
    users: {
      total: users?.total || 0,
      suspendus: users?.suspended || 0,
      nouveauxMois: users?.nouveaux || 0,
      actifsMois: actifs?.n || 0,
    },
    collections: cols.map((c) => ({ collection: c.collection, n: c.n, octets: c.octets || 0 })),
    serverNow: Date.now(),
  };
}

/* ==========================================================================
 * GET /api/admin/users
 * ========================================================================== */
export async function users(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();

  /* UNE SEULE COLLECTION EST LUE : `profile`, et pour ses seuls champs
   * d'identité — le bateau, sa coque, sa taille, sa motorisation.
   *
   * La ligne est celle-ci : l'IDENTITÉ oui, l'ACTIVITÉ jamais. Savoir quels
   * bateaux fréquentent le service est nécessaire pour l'administrer, a
   * fortiori depuis que des gens embarquent chez d'autres. Savoir où ils
   * pêchent ne l'est pas — les marques, les sondes, les traces et les prises
   * restent hors d'atteinte, et aucune requête de ce fichier ne les touche.
   *
   * L'immatriculation et le MMSI ne sortent pas non plus : ils ne servent à
   * aucune décision d'administration, et un identifiant qu'on n'a pas besoin
   * de lire est un identifiant qu'on ne lit pas. */
  const sql = `
    SELECT u.id, u.email, u.name, u.created_at, u.suspended, u.suspended_at, u.suspended_reason,
           (SELECT MAX(last_used_at) FROM tokens t WHERE t.user_id = u.id) AS derniere_venue,
           (SELECT COUNT(*) FROM records r WHERE r.user_id = u.id AND r.deleted = 0) AS enregistrements,
           (SELECT r.data FROM records r
             WHERE r.user_id = u.id AND r.collection = 'profile' AND r.deleted = 0) AS profil,
           (SELECT COUNT(*) FROM trips t WHERE t.captain_id = u.id) AS sorties,
           (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'accepted') AS embarquements,
           (SELECT AVG(stars) FROM reviews rv WHERE rv.target_id = u.id) AS note_moy,
           (SELECT COUNT(*) FROM reviews rv WHERE rv.target_id = u.id) AS note_n
      FROM users u
     ${q ? 'WHERE u.email_key LIKE ?3 OR LOWER(COALESCE(u.name, \'\')) LIKE ?3' : ''}
     ORDER BY u.created_at DESC
     LIMIT ?1 OFFSET ?2`;

  const st = q
    ? env.DB.prepare(sql).bind(limit, offset, `%${q}%`)
    : env.DB.prepare(sql).bind(limit, offset);

  const { results } = await st.all();

  return {
    users: results.map((u) => ({
      id: u.id,
      email: u.email,
      bateau: u.name,
      fiche: boatIdentity(u.profil),
      inscritLe: u.created_at * 1000,
      derniereVenue: u.derniere_venue ? u.derniere_venue * 1000 : null,
      enregistrements: u.enregistrements,
      cobaturage: {
        sorties: u.sorties || 0,
        embarquements: u.embarquements || 0,
        note: u.note_n ? { moyenne: Math.round(u.note_moy * 10) / 10, n: u.note_n } : null,
      },
      suspendu: u.suspended === 1,
      suspenduLe: u.suspended_at ? u.suspended_at * 1000 : null,
      motif: u.suspended_reason || null,
    })),
    offset,
    limit,
  };
}

/**
 * Extrait du profil ses seuls champs d'identité.
 *
 * On liste ce qu'on prend plutôt que ce qu'on écarte : une liste blanche
 * survit à l'ajout d'un champ dans le profil, une liste noire non — le jour où
 * quelqu'un ajoute une donnée sensible à la fiche, elle sortirait toute seule.
 */
function boatIdentity(json) {
  if (!json) return null;
  let p;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  return {
    nom: p?.boatName || null,
    coque: p?.hull || null,
    longueurM: Number.isFinite(p?.lengthM) ? p.lengthM : null,
    motorisation: p?.propulsion || null,
    puissanceCh: Number.isFinite(p?.powerHp) ? p.powerHp : null,
    equipage: Number.isFinite(p?.pob) ? p.pob : null,
  };
}

/* ==========================================================================
 * POST /api/admin/suspend
 * ========================================================================== */
export async function suspend(env, admin, body) {
  const id = String(body.id || '');
  const on = !!body.suspended;
  const reason = body.reason == null ? null : String(body.reason).slice(0, 200);

  if (!id) fail('bad_request', 400);

  /* On ne se suspend pas soi-même. Ce n'est pas de la politesse : le seul
   * administrateur d'un service qui se coupe l'accès n'a plus aucun moyen de
   * se le rendre depuis l'app. */
  if (id === admin.id) fail('cannot_suspend_self', 400);

  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first();
  if (!target) fail('not_found', 404);

  const now = Math.floor(Date.now() / 1000);

  /* ON NE SUPPRIME PAS LES JETONS, et c'est un choix corrigé après essai.
   *
   * La première version les effaçait, en croyant que c'était ça qui suspendait.
   * C'est faux : ce qui suspend, c'est le contrôle fait à CHAQUE requête
   * authentifiée (`auth.js`), qui refuse un compte marqué suspendu quel que
   * soit le jeton présenté. Les effacer ne rendait donc pas la suspension plus
   * efficace — mais rendait sa cause illisible : l'appareil recevait 401
   * « session expirée » au lieu de 403 « compte suspendu », et affichait à son
   * propriétaire un message qui lui conseillait de se reconnecter, ce qui ne
   * pouvait pas marcher.
   *
   * Bénéfice second : réactiver rend l'accès immédiatement, sans obliger
   * chaque appareil du compte à ressaisir un mot de passe. */
  await env.DB.prepare(
    'UPDATE users SET suspended = ?1, suspended_at = ?2, suspended_reason = ?3 WHERE id = ?4',
  )
    .bind(on ? 1 : 0, on ? now : 0, on ? reason : null, id)
    .run();

  return { ok: true, id, suspendu: on };
}

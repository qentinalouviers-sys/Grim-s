/* ==========================================================================
 * sync.js — pousser, tirer, exporter, supprimer
 * --------------------------------------------------------------------------
 * LE CURSEUR, ET POURQUOI IL N'EST PAS UNE HORLOGE
 *
 * Le client range le curseur qu'on lui rend et ne revient jamais en arrière :
 * ce qui est sauté est sauté pour de bon. Deux fausses bonnes idées :
 *
 *   `updatedAt` — il vient du client. Un téléphone dont l'horloge retarde de
 *   dix minutes pousse une prise datée dans le passé : elle se range AVANT le
 *   curseur des autres appareils, qui ne la voient jamais redescendre.
 *
 *   l'heure du serveur — deux écritures dans la même milliseconde partagent
 *   la même valeur, et une lecture « strictement supérieure » en saute une.
 *
 * Ici le curseur est `MAX(seq) + 1` PAR COMPTE, calculé dans la requête
 * d'écriture elle-même. SQLite sérialise les écritures : deux envois
 * simultanés ne peuvent donc pas obtenir le même numéro, ni s'intercaler sous
 * le curseur d'une lecture déjà servie. Il n'y a aucune fenêtre à refermer,
 * parce qu'il n'y en a jamais eu.
 *
 * Et la lecture ne rend JAMAIS un curseur plus loin que ce qu'elle a
 * réellement envoyé — c'est ce qui rend une lecture tronquée inoffensive.
 * ========================================================================== */

import { fail } from './http.js';

/**
 * Collections acceptées, et leur nature. La liste est fermée : un client
 * modifié pourrait sinon écrire n'importe quel nom et faire de ce compte un
 * espace de stockage gratuit.
 */
const COLLECTIONS = {
  catches: 'records',
  spots: 'records',
  tracks: 'records',
  profile: 'blob',
  settings: 'blob',
  customSpecies: 'blob',
  driftObs: 'blob',
  soundings: 'blob',
  wxAlerts: 'blob',
};

const PULL_ROWS = 2000;
const PULL_BYTES = 6 * 1024 * 1024;
const MAX_CHANGES = 5000;

/* D1 limite le nombre d'instructions par lot. On découpe, et chaque tranche
 * reste une transaction : l'ordre des numéros est conservé puisqu'ils sont
 * calculés à l'écriture, pas réservés d'avance. */
const BATCH = 200;

const UPSERT = `
INSERT INTO records (user_id, collection, rec_id, updated_at, seq, deleted, data)
VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(seq), 0) FROM records WHERE user_id = ?1) + 1, ?5, ?6)
ON CONFLICT (user_id, collection, rec_id) DO UPDATE SET
  updated_at = excluded.updated_at,
  seq        = excluded.seq,
  deleted    = excluded.deleted,
  data       = excluded.data
WHERE excluded.updated_at > records.updated_at`;

export async function push(env, user, body) {
  const changes = body.changes;
  if (!Array.isArray(changes)) fail('bad_request', 400);
  if (changes.length > MAX_CHANGES) fail('too_large', 413);
  if (changes.length === 0) return { applied: 0 };

  /* Tout valider AVANT d'écrire quoi que ce soit. Un lot à moitié appliqué
   * laisse le client persuadé que le reste est monté : il range son point de
   * reprise et ne repoussera jamais ce qui manque. */
  const clean = [];
  for (const c of changes) {
    if (!c || typeof c !== 'object') fail('bad_request', 400);

    const col = String(c.collection || '');
    const kind = COLLECTIONS[col];
    if (!kind) fail('bad_request', 400);

    const id = String(c.id || '');
    if (!id || id.length > 128) fail('bad_request', 400);
    /* Pour un blob, l'identifiant EST le nom de la collection. Laisser passer
     * autre chose créerait des documents fantômes que le client ne
     * redescendra jamais, puisqu'il n'en connaît qu'un. */
    if (kind === 'blob' && id !== col) fail('bad_request', 400);

    const deleted = !!c.deleted;
    const updatedAt = Number(c.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) fail('bad_request', 400);

    let data = null;
    if (!deleted) {
      if (c.data === undefined || c.data === null) fail('bad_request', 400);
      data = JSON.stringify(c.data);
    }
    clean.push([col, id, Math.trunc(updatedAt), deleted ? 1 : 0, data]);
  }

  let applied = 0;
  for (let i = 0; i < clean.length; i += BATCH) {
    const slice = clean.slice(i, i + BATCH);
    const results = await env.DB.batch(
      slice.map(([col, id, updatedAt, deleted, data]) =>
        env.DB.prepare(UPSERT).bind(user.id, col, id, updatedAt, deleted, data),
      ),
    );
    for (const r of results) applied += r?.meta?.changes || 0;
  }

  return { applied };
}

export async function pull(env, user, url) {
  let since = Number(url.searchParams.get('since') || 0);
  if (!Number.isFinite(since) || since < 0) since = 0;

  const { results } = await env.DB.prepare(
    `SELECT collection, rec_id, updated_at, deleted, data, seq
       FROM records
      WHERE user_id = ?1 AND seq > ?2
      ORDER BY seq
      LIMIT ?3`,
  )
    .bind(user.id, since, PULL_ROWS)
    .all();

  const out = [];
  let bytes = 0;
  let last = since;
  let truncated = false;

  for (const r of results) {
    const len = (r.data || '').length;
    /* On coupe AVANT d'ajouter, et jamais sur la première ligne : un carnet de
     * sondes plus gros que le plafond doit passer quand même, quitte à faire
     * une réponse hors norme. Le refuser bloquerait la synchro pour toujours,
     * sans aucune issue. */
    if (out.length && bytes + len > PULL_BYTES) {
      truncated = true;
      break;
    }
    bytes += len;
    last = r.seq;
    out.push({
      collection: r.collection,
      id: r.rec_id,
      updatedAt: r.updated_at,
      deleted: r.deleted === 1,
      data: r.data === null ? null : JSON.parse(r.data),
    });
  }

  if (results.length >= PULL_ROWS) truncated = true;

  /* Le curseur rendu ne dépasse jamais la dernière ligne réellement envoyée.
   * Annoncer plus loin ferait perdre le reste en silence — le genre de perte
   * que personne ne remarque avant des mois. */
  return { serverNow: last, records: out, more: truncated };
}

export async function exportAll(env, user) {
  const { results } = await env.DB.prepare(
    'SELECT collection, rec_id, updated_at, deleted, data FROM records WHERE user_id = ?1 ORDER BY collection, rec_id',
  )
    .bind(user.id)
    .all();

  return {
    user,
    exportedAt: Date.now(),
    records: results.map((r) => ({
      collection: r.collection,
      id: r.rec_id,
      updatedAt: r.updated_at,
      deleted: r.deleted === 1,
      data: r.data === null ? null : JSON.parse(r.data),
    })),
  };
}

export async function deleteAccount(env, user) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM tokens WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM resets WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(user.id),
  ]);
  return { ok: true };
}

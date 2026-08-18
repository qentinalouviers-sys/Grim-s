/* ==========================================================================
 * corpus.js — le fonds de données, vu depuis l'administration
 * --------------------------------------------------------------------------
 * POURQUOI CE FICHIER EXISTE, ET CE QU'IL CHANGE
 *
 * Jusqu'ici l'administration voyait QUI utilise le service et jamais QUOI. Ce
 * fichier ouvre le QUOI, délibérément et pour une raison précise : le but de
 * l'app est de constituer un corpus de pêche — prises, positions, conditions —
 * pour en tirer un modèle de prédiction. Un corpus qu'on ne peut ni regarder,
 * ni compter, ni exporter n'est pas un corpus, c'est un débarras.
 *
 * Ce n'est donc PAS un contournement de la règle tenue dans `admin.js` : c'est
 * une seconde porte, nommée, séparée, et qui dit ce qu'elle est. `admin.js`
 * continue de ne lire que l'identité ; tout ce qui touche au contenu passe
 * ici, où l'on peut le voir d'un coup d'œil.
 *
 * CE QUE ÇA IMPLIQUE, ET QUI DOIT LE SAVOIR
 *
 * Une position de pêche rattachée à une personne identifiée est une donnée
 * personnelle. Les pêcheurs doivent donc l'apprendre de l'app, pas d'une
 * mauvaise surprise : `js/ui/dataterms.js` l'affiche à l'inscription et le
 * rappelle dans les réglages. Le code de collecte et la mention à
 * l'utilisateur se livrent ensemble ; l'un sans l'autre serait une faute.
 *
 * L'EXPORT NE PORTE PAS D'ADRESSE
 *
 * Un export part dans des outils, des carnets, des machines d'entraînement. Il
 * ne rend donc que l'identifiant de compte — `u_` suivi de seize caractères
 * tirés au hasard, sans lien avec l'adresse (voir `auth.js`). C'est déjà un
 * pseudonyme, et il suffit à regrouper les observations d'un même pêcheur, ce
 * dont un modèle a besoin. L'adresse, elle, n'a aucune valeur prédictive : la
 * retirer ne coûte rien au modèle et retire tout au fichier qui fuiterait.
 *
 * LE POINT TECHNIQUE QUI COMMANDE TOUT LE RESTE
 *
 * Le plan gratuit accorde 10 ms de CPU par requête. Parser en JavaScript
 * quelques milliers d'enregistrements JSON les dépasse largement — le Worker
 * serait tué en plein vol, et le seul écran qui compte ici ne s'afficherait
 * jamais.
 *
 * Donc AUCUN `JSON.parse` dans ce fichier. L'extraction est faite par SQLite,
 * en C, du côté de D1 : `->>` pour un champ, `json_each()` pour éclater un
 * blob de sondes en autant de lignes. Le temps passé là n'est pas du CPU de
 * Worker. Vérifié sur D1 avant d'écrire la première route :
 *
 *     SELECT json_extract('{"lat":49.93}','$.lat')            → 49.93
 *     SELECT j.value ->> '$.zeroM' FROM json_each('[…]') j    → une ligne par sonde
 *
 * `json_valid()` garde les requêtes : un blob tronqué ferait échouer
 * `json_each` sur TOUTE la requête, et une seule ligne abîmée effacerait la
 * carte de tout le monde.
 * ========================================================================== */

import { fail } from './http.js';

/** Plafond dur. Au-delà, la carte n'est plus lisible et la réponse n'est plus transportable. */
const MAX_POINTS = 5000;
const DEFAULT_POINTS = 2000;

/* ==========================================================================
 * Filtres communs
 * ========================================================================== */

/**
 * Fenêtre géographique, « S,W,N,E » en degrés.
 *
 * Rendre null plutôt que lever : une boîte mal formée dans une URL ne mérite
 * pas une erreur, elle mérite d'être ignorée — l'écran affiche alors tout,
 * ce qui est visible et se corrige, là où un 400 laisse une carte vide.
 */
function bbox(url) {
  const raw = String(url.searchParams.get('bbox') || '').split(',').map(Number);
  if (raw.length !== 4 || raw.some((n) => !Number.isFinite(n))) return null;
  const [s, w, n, e] = raw;
  if (s > n || w > e) return null;
  return { s, w, n, e };
}

function window_(url) {
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  return {
    from: Number.isFinite(from) && from > 0 ? from : null,
    to: Number.isFinite(to) && to > 0 ? to : null,
  };
}

function limitOf(url, fallback = DEFAULT_POINTS) {
  const n = Number(url.searchParams.get('limit'));
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, 1), MAX_POINTS);
}

/* ==========================================================================
 * GET /api/admin/corpus/points
 * --------------------------------------------------------------------------
 * Les points de tous les comptes, pour la carte.
 *
 * kind = catches | soundings | spots
 *
 * Le compte est rendu par son IDENTIFIANT, jamais par son adresse : l'écran
 * possède déjà la liste des comptes et sait faire la correspondance. Une
 * réponse qui ne porte pas d'adresse est une réponse qu'on peut journaliser,
 * mettre en cache ou copier sans y penser.
 * ========================================================================== */
export async function points(env, url) {
  const kind = String(url.searchParams.get('kind') || 'catches');
  const box = bbox(url);
  const { from, to } = window_(url);
  const limit = limitOf(url);
  const user = String(url.searchParams.get('user') || '').trim();
  const species = String(url.searchParams.get('species') || '').trim();

  /* Chaque type définit sa projection ; le filtrage, lui, est écrit UNE fois
   * plus bas. Les sondes et les marques n'ont pas d'espèce — le filtre par
   * espèce ne s'applique donc qu'aux prises, et le demander ailleurs ne rend
   * pas d'erreur : il ne s'applique simplement pas. */
  const SOURCES = {
    catches: {
      sql: `SELECT r.user_id AS uid, r.rec_id AS rid,
                   r.data ->> '$.lat'          AS lat,
                   r.data ->> '$.lon'          AS lon,
                   r.data ->> '$.t'            AS t,
                   r.data ->> '$.speciesId'    AS sp,
                   r.data ->> '$.speciesName'  AS spn,
                   r.data ->> '$.lengthCm'     AS len,
                   r.data ->> '$.count'        AS n,
                   r.data ->> '$.released'     AS rel,
                   r.data ->> '$.snapshot.heightM'     AS maree,
                   r.data ->> '$.snapshot.coefficient' AS coef,
                   r.data ->> '$.snapshot.windSpeedKn' AS vent,
                   r.data ->> '$.snapshot.windDirDeg'  AS ventDir,
                   r.data ->> '$.snapshot.waterDepthM' AS fond
              FROM records r
             WHERE r.collection = 'catches' AND r.deleted = 0 AND json_valid(r.data)`,
      species: true,
    },
    spots: {
      sql: `SELECT r.user_id AS uid, r.rec_id AS rid,
                   r.data ->> '$.lat'       AS lat,
                   r.data ->> '$.lon'       AS lon,
                   r.data ->> '$.createdAt' AS t,
                   r.data ->> '$.name'      AS nom,
                   r.data ->> '$.depthM'    AS fond,
                   r.data ->> '$.radiusM'   AS rayon
              FROM records r
             WHERE r.collection = 'spots' AND r.deleted = 0 AND json_valid(r.data)`,
      species: false,
    },
    /* Les sondes vivent en UN enregistrement par compte, contenant un tableau.
     * `json_each` l'éclate en lignes du côté de SQLite — c'est exactement ce
     * qu'on ne veut pas faire en JavaScript ici. */
    soundings: {
      sql: `SELECT r.user_id AS uid,
                   j.value ->> '$.id'        AS rid,
                   j.value ->> '$.lat'       AS lat,
                   j.value ->> '$.lon'       AS lon,
                   j.value ->> '$.t'         AS t,
                   j.value ->> '$.zeroM'     AS zero,
                   j.value ->> '$.rawM'      AS brut,
                   j.value ->> '$.tideTrust' AS fiabilite
              FROM records r, json_each(r.data) j
             WHERE r.collection = 'soundings' AND r.deleted = 0 AND json_valid(r.data)`,
      species: false,
    },
  };

  const src = SOURCES[kind];
  if (!src) fail('bad_request', 400);

  const where = [];
  const args = [];

  /* `lat IS NOT NULL` n'est pas une précaution de style : une prise saisie
   * sans position GPS est enregistrée quand même (on ne retient pas la main de
   * quelqu'un qui tient un poisson), et elle n'a rien à faire sur une carte. */
  where.push('lat IS NOT NULL', 'lon IS NOT NULL');

  if (box) {
    where.push('lat >= ?', 'lat <= ?', 'lon >= ?', 'lon <= ?');
    args.push(box.s, box.n, box.w, box.e);
  }
  if (from) { where.push('t >= ?'); args.push(from); }
  if (to) { where.push('t <= ?'); args.push(to); }
  if (user) { where.push('uid = ?'); args.push(user); }
  if (species && src.species) { where.push('sp = ?'); args.push(species); }

  const sql = `WITH p AS (${src.sql})
               SELECT * FROM p
                WHERE ${where.join(' AND ')}
                ORDER BY t DESC
                LIMIT ?`;
  args.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...args).all();

  /* Une réponse tronquée doit le DIRE. Sans ce drapeau, l'écran montrerait
   * deux mille points en laissant croire qu'il les montre tous — et on tirerait
   * des conclusions de zone sur un échantillon arbitraire. */
  return { kind, points: results, tronque: results.length >= limit, limite: limit };
}

/* ==========================================================================
 * GET /api/admin/corpus/stats
 * --------------------------------------------------------------------------
 * De quoi répondre à « où en est le corpus ? » sans rien télécharger.
 * ========================================================================== */
export async function stats(env) {
  /* Ce qui compte pour un modèle, ce n'est pas le nombre de prises : c'est le
   * nombre de prises EXPLOITABLES — celles qui portent une position et le
   * relevé des conditions. Les deux chiffres côte à côte disent d'un coup
   * quelle part du corpus est réellement utilisable. */
  const prises = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN data ->> '$.lat' IS NOT NULL THEN 1 ELSE 0 END) AS situees,
            SUM(CASE WHEN data ->> '$.lat' IS NOT NULL
                      AND data ->> '$.snapshot.heightM' IS NOT NULL THEN 1 ELSE 0 END) AS exploitables,
            MIN(data ->> '$.t') AS premiere,
            MAX(data ->> '$.t') AS derniere,
            COUNT(DISTINCT user_id) AS contributeurs
       FROM records
      WHERE collection = 'catches' AND deleted = 0 AND json_valid(data)`,
  ).first();

  const { results: especes } = await env.DB.prepare(
    `SELECT data ->> '$.speciesId'   AS id,
            data ->> '$.speciesName' AS nom,
            COUNT(*)                 AS n,
            SUM(CASE WHEN data ->> '$.released' IN (1, 'true') THEN 1 ELSE 0 END) AS relachees,
            AVG(data ->> '$.lengthCm') AS taille_moy,
            COUNT(DISTINCT user_id)  AS pecheurs
       FROM records
      WHERE collection = 'catches' AND deleted = 0 AND json_valid(data)
        AND data ->> '$.speciesId' IS NOT NULL
      GROUP BY id
      ORDER BY n DESC
      LIMIT 60`,
  ).all();

  const sondes = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN j.value ->> '$.zeroM' IS NOT NULL THEN 1 ELSE 0 END) AS corrigees,
            COUNT(DISTINCT r.user_id) AS contributeurs
       FROM records r, json_each(r.data) j
      WHERE r.collection = 'soundings' AND r.deleted = 0 AND json_valid(r.data)`,
  ).first();

  const marques = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT user_id) AS contributeurs
       FROM records
      WHERE collection = 'spots' AND deleted = 0 AND json_valid(data)`,
  ).first();

  /* Qui alimente le fonds. Par identifiant : l'écran connaît déjà les noms. */
  const { results: top } = await env.DB.prepare(
    `SELECT user_id AS uid, COUNT(*) AS prises
       FROM records
      WHERE collection = 'catches' AND deleted = 0 AND json_valid(data)
        AND data ->> '$.lat' IS NOT NULL
      GROUP BY user_id ORDER BY prises DESC LIMIT 25`,
  ).all();

  /* Le rythme mensuel. `t` est en millisecondes : SQLite veut des secondes. */
  const { results: mois } = await env.DB.prepare(
    `SELECT strftime('%Y-%m', (data ->> '$.t') / 1000, 'unixepoch') AS mois,
            COUNT(*) AS n
       FROM records
      WHERE collection = 'catches' AND deleted = 0 AND json_valid(data)
        AND data ->> '$.t' IS NOT NULL
      GROUP BY mois ORDER BY mois DESC LIMIT 36`,
  ).all();

  return {
    prises: {
      total: prises?.total || 0,
      situees: prises?.situees || 0,
      exploitables: prises?.exploitables || 0,
      contributeurs: prises?.contributeurs || 0,
      premiere: prises?.premiere ? Number(prises.premiere) : null,
      derniere: prises?.derniere ? Number(prises.derniere) : null,
    },
    especes: especes.map((e) => ({
      id: e.id,
      nom: e.nom,
      n: e.n,
      relachees: e.relachees || 0,
      tailleMoyCm: e.taille_moy == null ? null : Math.round(e.taille_moy * 10) / 10,
      pecheurs: e.pecheurs,
    })),
    sondes: {
      total: sondes?.total || 0,
      corrigees: sondes?.corrigees || 0,
      contributeurs: sondes?.contributeurs || 0,
    },
    marques: { total: marques?.total || 0, contributeurs: marques?.contributeurs || 0 },
    contributeurs: top,
    mois,
  };
}

/* ==========================================================================
 * GET /api/admin/corpus/user?id=…
 * --------------------------------------------------------------------------
 * Le détail d'UN compte : ce qu'il a déposé, en volume et en résumé.
 * ========================================================================== */
export async function userDetail(env, url) {
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) fail('bad_request', 400);

  const u = await env.DB.prepare(
    'SELECT id, email, name, created_at, suspended FROM users WHERE id = ?1',
  ).bind(id).first();
  if (!u) fail('not_found', 404);

  const { results: cols } = await env.DB.prepare(
    `SELECT collection, COUNT(*) AS n, SUM(length(COALESCE(data, ''))) AS octets
       FROM records WHERE user_id = ?1 AND deleted = 0
      GROUP BY collection ORDER BY collection`,
  ).bind(id).all();

  const { results: especes } = await env.DB.prepare(
    `SELECT data ->> '$.speciesName' AS nom, COUNT(*) AS n,
            MAX(data ->> '$.lengthCm') AS record_cm
       FROM records
      WHERE user_id = ?1 AND collection = 'catches' AND deleted = 0 AND json_valid(data)
        AND data ->> '$.speciesId' IS NOT NULL
      GROUP BY data ->> '$.speciesId' ORDER BY n DESC LIMIT 40`,
  ).bind(id).all();

  const prises = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN data ->> '$.lat' IS NOT NULL THEN 1 ELSE 0 END) AS situees,
            MIN(data ->> '$.t') AS premiere, MAX(data ->> '$.t') AS derniere
       FROM records
      WHERE user_id = ?1 AND collection = 'catches' AND deleted = 0 AND json_valid(data)`,
  ).bind(id).first();

  const sondes = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM records r, json_each(r.data) j
      WHERE r.user_id = ?1 AND r.collection = 'soundings' AND r.deleted = 0 AND json_valid(r.data)`,
  ).bind(id).first();

  return {
    compte: {
      id: u.id,
      email: u.email,
      bateau: u.name,
      inscritLe: u.created_at * 1000,
      suspendu: u.suspended === 1,
    },
    collections: cols.map((c) => ({ collection: c.collection, n: c.n, octets: c.octets || 0 })),
    prises: {
      n: prises?.n || 0,
      situees: prises?.situees || 0,
      premiere: prises?.premiere ? Number(prises.premiere) : null,
      derniere: prises?.derniere ? Number(prises.derniere) : null,
    },
    sondes: sondes?.n || 0,
    especes,
  };
}

/* ==========================================================================
 * GET /api/admin/corpus/export?after=…&limit=…
 * --------------------------------------------------------------------------
 * Le corpus destiné à l'entraînement, par tranches.
 *
 * PAR TRANCHES, et pas d'un bloc : un export unique de tout le fonds finirait
 * par dépasser la mémoire du Worker et échouerait précisément le jour où il y
 * a enfin assez de données pour valoir la peine.
 *
 * LE CURSEUR PORTE SUR (user_id, rec_id), PAS SUR `seq`.
 *
 * Première version écrite : `WHERE seq > ?`. Fausse. `seq` est monotone PAR
 * COMPTE — c'est ce qui fait marcher la synchronisation, chaque appareil
 * suivant l'avancement du sien. Le numéro 5 de deux comptes désigne deux
 * enregistrements sans rapport ; s'en servir comme curseur global aurait sauté
 * des lignes en silence, et un corpus amputé sans le dire est pire qu'un
 * export en échec — on entraîne un modèle sur un trou qu'on ne voit pas.
 *
 * (user_id, rec_id) est en revanche la clé primaire de la table : unique,
 * ordonnée, indexée. Le curseur y avance sans jamais répéter ni omettre.
 *
 * SANS ADRESSE. `user` porte l'identifiant de compte, qui est tiré au hasard
 * à l'inscription : il regroupe les observations d'un même pêcheur — ce dont
 * un modèle a besoin — sans dire de qui il s'agit.
 * ========================================================================== */
export async function exportCorpus(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1000, 1), 5000);
  const afterUser = String(url.searchParams.get('afterUser') || '');
  const afterRec = String(url.searchParams.get('afterRec') || '');

  /* On rend la prise ENTIÈRE, relevé de conditions compris : c'est lui qui
   * porte la marée, le vent, le fond, la phase lumineuse — les variables
   * explicatives. Sans elles il ne reste qu'un point sur une carte, dont on
   * n'apprend rien. La chaîne part telle quelle, sans être parsée ici. */
  const { results } = await env.DB.prepare(
    `SELECT user_id AS user, rec_id AS id, updated_at AS maj, data
       FROM records
      WHERE collection = 'catches' AND deleted = 0 AND json_valid(data)
        AND (user_id > ?1 OR (user_id = ?1 AND rec_id > ?2))
      ORDER BY user_id, rec_id LIMIT ?3`,
  ).bind(afterUser, afterRec, limit).all();

  const last = results.length ? results[results.length - 1] : null;

  return {
    lignes: results,
    /* Non nul tant qu'il reste à lire : l'appelant reboucle jusqu'à null. Une
     * tranche pleine ne prouve pas qu'il reste quelque chose, mais redemander
     * pour rien coûte une requête vide — se tromper dans l'autre sens
     * tronquerait le corpus. */
    suivant: results.length >= limit ? { user: last.user, rec: last.id } : null,
    rendu: results.length,
  };
}

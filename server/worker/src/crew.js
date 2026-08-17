/* ==========================================================================
 * crew.js — cobaturage : sorties partagées, places, avis
 * --------------------------------------------------------------------------
 * LE PLAFOND EST RECALCULÉ ICI, À PARTIR DU MÊME FICHIER QUE LE CLIENT.
 *
 * `js/core/cobaturage.js` est importé tel quel et empaqueté avec le Worker.
 * Ce n'est pas une commodité : c'est ce qui garantit que le montant affiché à
 * l'écran et le montant accepté par le serveur ne peuvent pas diverger. Deux
 * implémentations du même calcul auraient fini par se décaler d'un centime,
 * puis d'une règle.
 *
 * Le client ne fournit JAMAIS le plafond. Il envoie les frais et le nombre de
 * places ; le serveur calcule. Un client modifié n'obtient rien de plus.
 * ========================================================================== */

import { fail } from './http.js';
import { share, validate } from '../../../js/core/cobaturage.js';

const now = () => Date.now();
const id = (p) => `${p}_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const cents = (v) => Math.max(0, Math.round(Number(v) || 0));

/** Trente jours : au-delà, une sortie annoncée n'a plus de sens météo. */
const HORIZON_MS = 30 * 86400_000;

/* ==========================================================================
 * Publier une sortie
 * ========================================================================== */
export async function publish(env, user, body) {
  const costs = {
    fuel: cents(body?.costs?.fuel),
    port: cents(body?.costs?.port),
    bait: cents(body?.costs?.bait),
    food: cents(body?.costs?.food),
  };
  const seats = Math.floor(Number(body?.seats) || 0);
  const departsAt = Math.floor(Number(body?.departsAt) || 0);
  const hours = Number(body?.hours) || 0;

  /* Le calcul fait foi. S'il refuse, on refuse — et on rend SA raison, pas un
   * message générique : « au-delà du partage des frais » n'apprend rien, alors
   * que « part par personne inhabituellement élevée » dit quoi corriger. */
  const s = share(costs, seats);
  if (!s.ok) fail(s.reason ? 'invalid_trip' : 'bad_request', 400);

  if (!departsAt || departsAt < now() - 3600_000) fail('trip_in_past', 400);
  if (departsAt > now() + HORIZON_MS) fail('trip_too_far', 400);
  if (!(hours > 0 && hours <= 24)) fail('bad_request', 400);

  const port = str(body?.port, 80);
  if (!port) fail('bad_request', 400);

  const tripId = id('t');
  await env.DB.prepare(
    `INSERT INTO trips (id, captain_id, port, lat, lon, departs_at, hours, seats, fishing, notes,
                        cost_fuel_c, cost_port_c, cost_bait_c, cost_food_c, share_c, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'open',?16)`,
  )
    .bind(
      tripId, user.id, port,
      Number.isFinite(Number(body?.lat)) ? Number(body.lat) : null,
      Number.isFinite(Number(body?.lon)) ? Number(body.lon) : null,
      departsAt, hours, seats, str(body?.fishing, 40) || null, str(body?.notes, 400) || null,
      costs.fuel, costs.port, costs.bait, costs.food,
      s.shareC, now(),
    )
    .run();

  return { ok: true, id: tripId, shareC: s.shareC, totalC: s.totalC, captainC: s.captainC };
}

/* ==========================================================================
 * Les sorties à venir
 * ========================================================================== */
export async function list(env, user, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

  const { results } = await env.DB.prepare(
    `SELECT t.*,
            u.name AS boat,
            (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.status = 'accepted') AS taken,
            (SELECT status FROM bookings b WHERE b.trip_id = t.id AND b.user_id = ?2) AS my_status
       FROM trips t JOIN users u ON u.id = t.captain_id
      WHERE t.status = 'open' AND t.departs_at > ?1
      ORDER BY t.departs_at
      LIMIT ?3`,
  )
    .bind(now() - 3600_000, user.id, limit)
    .all();

  const rated = await ratings(env, results.map((t) => t.captain_id));

  return { trips: results.map((t) => view(t, user, rated)) };
}

/* ==========================================================================
 * Demander une place
 * ========================================================================== */
export async function book(env, user, body) {
  const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?1').bind(str(body?.tripId, 40)).first();
  if (!trip) fail('not_found', 404);
  if (trip.status !== 'open') fail('trip_closed', 409);
  if (trip.departs_at < now()) fail('trip_in_past', 409);

  /* On ne s'embarque pas soi-même. Ce n'est pas qu'une bizarrerie d'affichage :
   * un capitaine inscrit sur sa propre sortie pourrait ensuite s'auto-noter. */
  if (trip.captain_id === user.id) fail('own_trip', 400);

  const taken = await countAccepted(env, trip.id);
  if (taken >= trip.seats) fail('trip_full', 409);

  try {
    await env.DB.prepare(
      'INSERT INTO bookings (id, trip_id, user_id, status, message, created_at) VALUES (?1,?2,?3,\'pending\',?4,?5)',
    )
      .bind(id('b'), trip.id, user.id, str(body?.message, 300) || null, now())
      .run();
  } catch {
    // L'index unique a tranché : la demande existait déjà.
    fail('already_asked', 409);
  }
  return { ok: true };
}

/* ==========================================================================
 * Accepter ou refuser
 * ========================================================================== */
export async function decide(env, user, body) {
  const bookingId = str(body?.bookingId, 40);
  const accept = !!body?.accept;

  const b = await env.DB.prepare(
    `SELECT b.*, t.captain_id, t.seats, t.status AS trip_status, t.departs_at
       FROM bookings b JOIN trips t ON t.id = b.trip_id
      WHERE b.id = ?1`,
  )
    .bind(bookingId)
    .first();

  if (!b) fail('not_found', 404);
  if (b.captain_id !== user.id) fail('forbidden', 403);
  if (b.status !== 'pending') fail('already_decided', 409);

  if (accept) {
    /* On recompte À CET INSTANT plutôt que de se fier au compteur affiché :
     * deux acceptations lancées coup sur coup depuis deux écrans feraient
     * sinon embarquer une personne de plus que de places. */
    const taken = await countAccepted(env, b.trip_id);
    if (taken >= b.seats) fail('trip_full', 409);
  }

  await env.DB.prepare('UPDATE bookings SET status = ?1, decided_at = ?2 WHERE id = ?3')
    .bind(accept ? 'accepted' : 'declined', now(), bookingId)
    .run();

  return { ok: true, status: accept ? 'accepted' : 'declined' };
}

/** Le capitaine annule sa sortie. Les demandes tombent avec elle. */
export async function cancel(env, user, body) {
  const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?1').bind(str(body?.tripId, 40)).first();
  if (!trip) fail('not_found', 404);
  if (trip.captain_id !== user.id) fail('forbidden', 403);

  await env.DB.batch([
    env.DB.prepare('UPDATE trips SET status = \'cancelled\' WHERE id = ?1').bind(trip.id),
    env.DB.prepare('UPDATE bookings SET status = \'cancelled\' WHERE trip_id = ?1 AND status IN (\'pending\',\'accepted\')').bind(trip.id),
  ]);
  return { ok: true };
}

/* ==========================================================================
 * Mes sorties et mes demandes
 * ========================================================================== */
export async function mine(env, user) {
  const asCaptain = await env.DB.prepare(
    `SELECT t.*, u.name AS boat,
            (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.status = 'accepted') AS taken
       FROM trips t JOIN users u ON u.id = t.captain_id
      WHERE t.captain_id = ?1 ORDER BY t.departs_at DESC LIMIT 50`,
  ).bind(user.id).all();

  const requests = await env.DB.prepare(
    `SELECT b.id, b.trip_id, b.status, b.message, b.created_at,
            u.name AS boat, u.id AS user_id, t.departs_at, t.port, t.share_c
       FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN users u ON u.id = b.user_id
      WHERE t.captain_id = ?1 AND b.status = 'pending'
      ORDER BY b.created_at`,
  ).bind(user.id).all();

  const asCrew = await env.DB.prepare(
    `SELECT b.id AS booking_id, b.status AS my_status, t.*, u.name AS boat
       FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN users u ON u.id = t.captain_id
      WHERE b.user_id = ?1 ORDER BY t.departs_at DESC LIMIT 50`,
  ).bind(user.id).all();

  const rated = await ratings(env, [
    ...asCaptain.results.map((t) => t.captain_id),
    ...asCrew.results.map((t) => t.captain_id),
    ...requests.results.map((r) => r.user_id),
  ]);

  return {
    captain: asCaptain.results.map((t) => view(t, user, rated)),
    requests: requests.results.map((r) => ({
      bookingId: r.id, tripId: r.trip_id, port: r.port, departsAt: r.departs_at,
      shareC: r.share_c, message: r.message, pecheur: r.boat || '—',
      note: rated[r.user_id] || null,
    })),
    crew: asCrew.results.map((t) => ({ ...view(t, user, rated), bookingId: t.booking_id, myStatus: t.my_status })),
  };
}

/* ==========================================================================
 * Noter
 * ========================================================================== */
export async function review(env, user, body) {
  const tripId = str(body?.tripId, 40);
  const targetId = str(body?.targetId, 40);
  const stars = Math.floor(Number(body?.stars) || 0);

  if (stars < 1 || stars > 5) fail('bad_request', 400);
  if (targetId === user.id) fail('bad_request', 400);

  const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?1').bind(tripId).first();
  if (!trip) fail('not_found', 404);

  /* On ne note pas une sortie qui n'a pas eu lieu. Sans cette barrière, on
   * pourrait démolir la réputation de quelqu'un sur une sortie annoncée à
   * laquelle personne n'est encore monté. */
  if (trip.departs_at > now()) fail('trip_not_yet', 409);
  if (trip.status === 'cancelled') fail('trip_cancelled', 409);

  const aboard = async (uid) => {
    if (trip.captain_id === uid) return 'captain';
    const b = await env.DB.prepare(
      'SELECT status FROM bookings WHERE trip_id = ?1 AND user_id = ?2',
    ).bind(tripId, uid).first();
    return b?.status === 'accepted' ? 'crew' : null;
  };

  /* Les deux doivent avoir été à bord. C'est la seule chose qui distingue un
   * avis d'un commentaire de comptoir. */
  const mineRole = await aboard(user.id);
  const theirRole = await aboard(targetId);
  if (!mineRole) fail('not_aboard', 403);
  if (!theirRole) fail('target_not_aboard', 400);

  try {
    await env.DB.prepare(
      'INSERT INTO reviews (id, trip_id, author_id, target_id, role, stars, comment, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    )
      .bind(id('r'), tripId, user.id, targetId, theirRole, stars, str(body?.comment, 400) || null, now())
      .run();
  } catch {
    fail('already_reviewed', 409);
  }
  return { ok: true };
}

/** Les avis reçus par quelqu'un, séparés par rôle. */
export async function reputation(env, url) {
  const uid = str(url.searchParams.get('id'), 40);
  if (!uid) fail('bad_request', 400);

  const { results } = await env.DB.prepare(
    `SELECT r.role, r.stars, r.comment, r.created_at, u.name AS auteur
       FROM reviews r JOIN users u ON u.id = r.author_id
      WHERE r.target_id = ?1 ORDER BY r.created_at DESC LIMIT 50`,
  ).bind(uid).all();

  const rated = await ratings(env, [uid]);
  return { note: rated[uid] || null, avis: results };
}

/* ==========================================================================
 * Interne
 * ========================================================================== */

async function countAccepted(env, tripId) {
  const r = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?1 AND status = \'accepted\'',
  ).bind(tripId).first();
  return r?.n || 0;
}

/** Moyenne et nombre d'avis, par personne et par rôle. */
async function ratings(env, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};

  const holes = uniq.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT target_id, role, AVG(stars) AS moy, COUNT(*) AS n
       FROM reviews WHERE target_id IN (${holes}) GROUP BY target_id, role`,
  ).bind(...uniq).all();

  const out = {};
  for (const r of results) {
    out[r.target_id] ??= {};
    out[r.target_id][r.role] = { moyenne: Math.round(r.moy * 10) / 10, n: r.n };
  }
  return out;
}

/**
 * La forme rendue au client.
 *
 * Les frais détaillés ne sortent QUE pour le capitaine de la sortie. Un
 * équipier a besoin de savoir ce qu'on lui demande et que c'est bien un
 * partage ; le détail du plein de gasoil du voisin ne le regarde pas.
 */
function view(t, user, rated) {
  const isMine = t.captain_id === user.id;
  return {
    id: t.id,
    port: t.port,
    lat: t.lat,
    lon: t.lon,
    departsAt: t.departs_at,
    hours: t.hours,
    seats: t.seats,
    taken: t.taken ?? 0,
    fishing: t.fishing,
    notes: t.notes,
    shareC: t.share_c,
    status: t.status,
    capitaine: { id: t.captain_id, bateau: t.boat || '—', note: rated[t.captain_id]?.captain || null },
    mine: isMine,
    myStatus: t.my_status || null,
    ...(isMine
      ? {
          costs: { fuel: t.cost_fuel_c, port: t.cost_port_c, bait: t.cost_bait_c, food: t.cost_food_c },
          totalC: t.cost_fuel_c + t.cost_port_c + t.cost_bait_c + t.cost_food_c,
        }
      : {}),
  };
}

export { validate };

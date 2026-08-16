/* ==========================================================================
 * http.js — entrée, sortie, CORS
 * --------------------------------------------------------------------------
 * Même règle que dans la version PHP, et pour la même raison : la réponse est
 * TOUJOURS du JSON, y compris sur une erreur. Le client fait `res.json()`
 * avant de regarder le statut ; une page d'erreur en HTML le fait tomber dans
 * « Serveur injoignable », qui n'apprend rien à personne.
 * ========================================================================== */

/** Corps maximal accepté. Au-delà : 413, jamais une coupure de connexion. */
export const MAX_BODY = 12 * 1024 * 1024;

/** Erreur métier : un code machine que le client traduit lui-même. */
export class ApiError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const fail = (code, status = 400) => {
  throw new ApiError(code, status);
};

/**
 * En-têtes CORS.
 *
 * L'app n'est pas servie par ce Worker : elle vit sur GitHub Pages ou sur le
 * domaine du propriétaire, et appelle depuis une AUTRE origine. Sans ces
 * en-têtes le navigateur bloque avant l'envoi, et le seul symptôme est
 * « Failed to fetch » — sans la moindre trace côté serveur, puisque la
 * requête n'y arrive jamais.
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const h = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h.Vary = 'Origin';
  }
  return h;
}

export function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors,
    },
  });
}

/**
 * Corps de la requête, décodé.
 *
 * Le garde-fou de taille est AVANT le décodage : analyser douze mégaoctets
 * consomme d'abord la mémoire et échoue ensuite, ce qui donne une panne opaque
 * au lieu d'un 413 explicite.
 */
export async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) fail('too_large', 413);

  const raw = await request.text();
  if (raw.length > MAX_BODY) fail('too_large', 413);
  if (!raw) return {};

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('bad_request', 400);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('bad_request', 400);
  return data;
}

/** Le jeton porteur, ou null. */
export function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Adresse du client, pour la limitation de débit.
 *
 * Sur Cloudflare, `CF-Connecting-IP` est posé par la plateforme elle-même et
 * ne peut pas être forgé par l'appelant — contrairement à `X-Forwarded-For`,
 * qu'on ne lit donc pas.
 */
export const clientIp = (request) =>
  request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || '0.0.0.0';

/* --------------------------------------------------------------------------
 * Comparaison à temps constant.
 * Comparer deux empreintes avec `===` s'arrête au premier octet différent, et
 * la durée trahit alors combien de tête est juste. On compare tout, toujours.
 * ------------------------------------------------------------------------ */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(str) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}

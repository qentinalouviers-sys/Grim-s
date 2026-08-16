/* ==========================================================================
 * index.js — point d'entrée du Worker
 * --------------------------------------------------------------------------
 * Toutes les routes passent ici, y compris celles qui n'existent pas : une
 * route inconnue doit rendre du JSON, jamais une page d'erreur. Le client lit
 * le corps avant le statut, et du HTML le fait tomber dans « Serveur
 * injoignable » alors que le serveur va parfaitement bien.
 * ========================================================================== */

import { ApiError, corsHeaders, json, readBody } from './http.js';
import * as auth from './auth.js';
import * as sync from './sync.js';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

    try {
      switch (route) {
        /* Sonde de bon fonctionnement : la première adresse à ouvrir après un
         * déploiement. Si elle ne répond pas, rien d'autre ne répondra. */
        case 'GET /api/health':
          return json(
            {
              ok: true,
              driver: 'd1',
              runtime: 'workers',
              records: (await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first())?.n ?? 0,
            },
            200,
            cors,
          );

        case 'POST /api/auth/register':
          return json(await auth.register(request, env, await readBody(request)), 200, cors);

        case 'POST /api/auth/login':
          return json(await auth.login(request, env, await readBody(request)), 200, cors);

        case 'POST /api/auth/logout':
          return json(await auth.logout(request, env), 200, cors);

        case 'POST /api/auth/forgot':
          return json(await auth.forgot(request, env, await readBody(request)), 200, cors);

        case 'GET /reset':
        case 'POST /reset':
          return auth.resetPage(request, env);

        case 'POST /api/sync/push':
          return json(
            await sync.push(env, await auth.requireUser(request, env), await readBody(request)),
            200,
            cors,
          );

        case 'GET /api/sync/pull':
          return json(await sync.pull(env, await auth.requireUser(request, env), url), 200, cors);

        case 'GET /api/account/export':
          return json(await sync.exportAll(env, await auth.requireUser(request, env)), 200, {
            ...cors,
            'Content-Disposition': 'attachment; filename="grims-export.json"',
          });

        case 'DELETE /api/account':
          return json(await sync.deleteAccount(env, await auth.requireUser(request, env)), 200, cors);

        default:
          return json({ error: 'not_found' }, 404, cors);
      }
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code }, e.status, cors);

      /* Le détail part dans les journaux, jamais dans la réponse : un message
       * d'erreur SQL rendu au client raconte le schéma à qui le demande. */
      console.error('[grims]', e?.stack || e);
      return json({ error: 'server_error' }, 500, cors);
    }
  },
};

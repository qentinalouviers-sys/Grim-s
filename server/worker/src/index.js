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
import * as admin from './admin.js';
import * as crew from './crew.js';

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
              /* Un booléen, jamais les adresses. Sans lui, un propriétaire qui
               * ne voit pas son panneau d'administration ne peut pas savoir si
               * c'est le secret qui manque ou son compte qui n'y figure pas —
               * et il n'a aucun moyen de trancher depuis son téléphone. */
              adminConfigured: !!String(env.ADMIN_EMAILS || '').trim(),
              invitesOnly: !!String(env.INVITE_CODE || '').trim(),
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

        /* ---- Cobaturage ------------------------------------------------
         * Toutes authentifiées : une sortie partagée met des gens sur un
         * bateau ensemble, et cela ne se fait pas sous couvert d'anonymat. */
        case 'GET /api/crew/trips':
          return json(await crew.list(env, await auth.requireUser(request, env), url), 200, cors);

        case 'POST /api/crew/publish':
          return json(
            await crew.publish(env, await auth.requireUser(request, env), await readBody(request)),
            200, cors,
          );

        case 'POST /api/crew/book':
          return json(
            await crew.book(env, await auth.requireUser(request, env), await readBody(request)),
            200, cors,
          );

        case 'POST /api/crew/decide':
          return json(
            await crew.decide(env, await auth.requireUser(request, env), await readBody(request)),
            200, cors,
          );

        case 'POST /api/crew/cancel':
          return json(
            await crew.cancel(env, await auth.requireUser(request, env), await readBody(request)),
            200, cors,
          );

        case 'GET /api/crew/mine':
          return json(await crew.mine(env, await auth.requireUser(request, env)), 200, cors);

        case 'POST /api/crew/review':
          return json(
            await crew.review(env, await auth.requireUser(request, env), await readBody(request)),
            200, cors,
          );

        case 'GET /api/crew/reputation':
          return json(
            (await auth.requireUser(request, env)) && (await crew.reputation(env, url)),
            200, cors,
          );

        /* Dit au client s'il doit afficher l'entrée d'administration. Une
         * route à part, sans droit requis : c'est une question sur soi-même,
         * et la poser ne doit pas produire un 403 dans les journaux à chaque
         * ouverture de l'écran de compte. */
        case 'GET /api/me': {
          const me = await auth.requireUser(request, env);
          return json({ ...me, admin: admin.isAdmin(env, me) }, 200, cors);
        }

        case 'GET /api/admin/overview': {
          const me = await auth.requireUser(request, env);
          admin.requireAdmin(env, me);
          return json(await admin.overview(env), 200, cors);
        }

        case 'GET /api/admin/users': {
          const me = await auth.requireUser(request, env);
          admin.requireAdmin(env, me);
          return json(await admin.users(env, url), 200, cors);
        }

        case 'POST /api/admin/suspend': {
          const me = await auth.requireUser(request, env);
          admin.requireAdmin(env, me);
          return json(await admin.suspend(env, me, await readBody(request)), 200, cors);
        }

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

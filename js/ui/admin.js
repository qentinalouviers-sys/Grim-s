/* ==========================================================================
 * ui/admin.js — le panneau d'administration
 * --------------------------------------------------------------------------
 * Il montre QUI utilise le service, jamais CE QU'ILS Y METTENT.
 *
 * Adresse, nom du bateau, date d'inscription, dernière venue, nombre
 * d'enregistrements, état de suspension. Pas une marque, pas une sonde, pas
 * une trace : ce sont des postes de pêche relevés à bord par des gens qui
 * n'ont pas envie de les publier, et administrer un service ne donne pas le
 * droit de lire ce qu'on y dépose. Le serveur applique déjà cette règle —
 * aucune de ses requêtes d'administration ne lit la donnée — mais elle mérite
 * d'être répétée ici, parce que c'est ici qu'on serait tenté de l'oublier.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as sync from '../core/sync.js';

const nf = new Intl.NumberFormat('fr-FR');

/** Poids lisible. Un carnet de sondes se compte en centaines de kilooctets. */
function poids(o) {
  if (!o) return '0 o';
  if (o < 1024) return `${o} o`;
  if (o < 1024 * 1024) return `${(o / 1024).toFixed(1)} ko`;
  return `${(o / 1048576).toFixed(1)} Mo`;
}

/** « il y a 3 jours » plutôt qu'une date : c'est la fraîcheur qui informe. */
function depuis(ms) {
  if (!ms) return 'jamais';
  const j = Math.floor((Date.now() - ms) / 86400000);
  if (j <= 0) return 'aujourd’hui';
  if (j === 1) return 'hier';
  if (j < 30) return `il y a ${j} j`;
  if (j < 365) return `il y a ${Math.floor(j / 30)} mois`;
  return `il y a ${Math.floor(j / 365)} an${j >= 730 ? 's' : ''}`;
}

export async function openAdmin() {
  const body = openSheet('Administration');
  body.append(el('p', 'tiny', 'Chargement…'));

  let data;
  try {
    const [ov, us] = await Promise.all([
      sync.apiCall('/api/admin/overview'),
      sync.apiCall('/api/admin/users?limit=200'),
    ]);
    data = { ov, us };
  } catch (e) {
    clear(body);
    body.append(el('p', 'c-red', e?.code === 'forbidden'
      ? 'Ce compte n’administre pas ce serveur.'
      : `Impossible de charger : ${e?.message || 'erreur'}`));
    return;
  }

  render(body, data);
}

function render(body, { ov, us }) {
  clear(body);

  /* --- Vue d'ensemble ------------------------------------------------- */
  const stats = el('div', 'card');
  stats.append(el('div', 'field-label', 'Comptes'));
  const grid = el('div', 'admin-grid');
  const tile = (val, lab) => {
    const t = el('div', 'admin-tile');
    t.append(el('div', 'admin-tile-val', nf.format(val)));
    t.append(el('div', 'admin-tile-lab', lab));
    return t;
  };
  grid.append(
    tile(ov.users.total, 'inscrits'),
    tile(ov.users.actifsMois, 'actifs 30 j'),
    tile(ov.users.nouveauxMois, 'nouveaux 30 j'),
    tile(ov.users.suspendus, 'suspendus'),
  );
  stats.append(grid);
  body.append(stats);

  /* --- Ce que le serveur porte ---------------------------------------- */
  const vol = el('div', 'card');
  vol.append(el('div', 'field-label', 'Données stockées'));
  if (!ov.collections.length) {
    vol.append(el('p', 'tiny', 'Rien encore.'));
  } else {
    for (const c of ov.collections) {
      const r = el('div', 'admin-row');
      r.append(el('span', 'admin-row-k', c.collection));
      r.append(el('span', 'admin-row-v', `${nf.format(c.n)} · ${poids(c.octets)}`));
      vol.append(r);
    }
  }
  /* Le volume, pas le contenu : `length(data)` mesure sans jamais rapporter. */
  vol.append(el('p', 'tiny', 'Volumes seulement — le contenu des comptes n’est pas lisible depuis ici.'));
  body.append(vol);

  /* --- La liste des comptes ------------------------------------------- */
  const list = el('div', 'card');
  list.append(el('div', 'field-label', `Comptes (${us.users.length})`));

  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Filtrer par e-mail ou bateau';
  search.className = 'admin-search';
  list.append(search);

  const host = el('div');
  list.append(host);
  body.append(list);

  const paint = (filter = '') => {
    clear(host);
    const f = filter.trim().toLowerCase();
    const rows = us.users.filter(
      (u) => !f || u.email.toLowerCase().includes(f) || (u.bateau || '').toLowerCase().includes(f),
    );
    if (!rows.length) {
      host.append(el('p', 'tiny', 'Aucun compte ne correspond.'));
      return;
    }
    for (const u of rows) host.append(userRow(u, us));
  };

  search.addEventListener('input', () => paint(search.value));
  paint();
}

function userRow(u, us) {
  const row = el('div', `admin-user${u.suspendu ? ' is-suspended' : ''}`);

  const head = el('div', 'admin-user-head');
  const idn = el('div', 'admin-user-id');
  // Le nom du bateau d'abord quand il existe : c'est sous ce nom qu'on se
  // reconnaît sur l'eau, l'adresse n'est qu'un identifiant.
  idn.append(el('div', 'admin-user-name', u.bateau || '— sans nom de bateau —'));
  idn.append(el('div', 'admin-user-mail', u.email));
  head.append(idn);
  if (u.suspendu) head.append(el('span', 'admin-badge', 'suspendu'));
  row.append(head);

  const meta = el('div', 'admin-user-meta');
  meta.append(el('span', null, `inscrit le ${new Date(u.inscritLe).toLocaleDateString('fr-FR')}`));
  meta.append(el('span', null, `vu ${depuis(u.derniereVenue)}`));
  meta.append(el('span', null, `${nf.format(u.enregistrements)} enreg.`));
  row.append(meta);

  if (u.suspendu && u.motif) row.append(el('div', 'tiny c-red', `Motif : ${u.motif}`));

  const act = el('div', 'btn-row');
  const b = button(
    u.suspendu ? 'Réactiver' : 'Suspendre',
    u.suspendu ? '' : 'btn-danger',
    async () => {
      let reason = null;
      if (!u.suspendu) {
        /* Un motif, même court. Un compte coupé sans raison notée devient un
         * mystère dans six mois — y compris pour celui qui l'a coupé. */
        reason = prompt('Motif de la suspension (visible seulement ici) :', '');
        if (reason === null) return;
      }
      b.disabled = true;
      b.textContent = '…';
      try {
        await sync.apiCall('/api/admin/suspend', {
          method: 'POST',
          body: { id: u.id, suspended: !u.suspendu, reason },
        });
        u.suspendu = !u.suspendu;
        u.motif = u.suspendu ? reason : null;
        toast(u.suspendu ? 'Compte suspendu — ses sessions sont coupées.' : 'Compte réactivé.', 'good');
        const fresh = userRow(u, us);
        row.replaceWith(fresh);
      } catch (e) {
        toast(
          e?.code === 'cannot_suspend_self'
            ? 'On ne peut pas se suspendre soi-même.'
            : `Échec : ${e?.message || 'erreur'}`,
          'danger',
        );
        b.disabled = false;
        b.textContent = u.suspendu ? 'Réactiver' : 'Suspendre';
      }
    },
  );
  act.append(b);
  row.append(act);

  return row;
}

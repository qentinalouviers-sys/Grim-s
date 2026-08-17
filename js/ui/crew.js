/* ==========================================================================
 * ui/crew.js — cobaturage
 * --------------------------------------------------------------------------
 * Embarquer des équipiers contre une participation aux frais. Trois écrans :
 * les sorties proposées, en publier une, et ce qui me concerne (mes sorties,
 * les demandes reçues, mes places obtenues).
 *
 * LE POINT DE CONCEPTION : IL N'Y A PAS DE CHAMP « PRIX ».
 *
 * Le capitaine saisit ce que la sortie coûte ; l'app divise par le nombre de
 * personnes À BORD, lui compris, et affiche le résultat. Un champ libre aurait
 * permis de fixer un tarif en une frappe — c'est-à-dire de faire du transport
 * de passagers sans navire classé, sans skipper professionnel et sans
 * assurance commerciale. Voir `core/cobaturage.js`, qui porte les règles.
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet, decimalInput } from './dom.js';
import * as sync from '../core/sync.js';
import * as profile from '../core/profile.js';
import * as places from '../data/places.js';
import * as cob from '../core/cobaturage.js';
import * as idb from '../core/idb.js';

const dt = (ms) =>
  new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** « ★ 4,6 (12) » — sans avis, on ne montre pas une note vide mais un mot. */
function stars(note) {
  if (!note || !note.n) return el('span', 'tiny c-dim', 'pas encore noté');
  return el('span', 'crew-stars', `★ ${String(note.moyenne).replace('.', ',')} (${note.n})`);
}

export async function openCrew() {
  /* `openSheet` rend `{close, back, body}` et attend le contenu en second
   * argument : on construit donc le conteneur AVANT de l'ouvrir. */
  const body = el('div');
  const tabs = el('div', 'seg');
  const host = el('div');

  const mk = (label, fn) => {
    const b = el('button', null, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      for (const x of tabs.children) x.classList.toggle('on', x === b);
      fn();
    });
    return b;
  };
  const tSorties = mk('Sorties', () => paintList(host));
  const tMoi = mk('Moi', () => paintMine(host));
  const tPub = mk('Proposer', () => paintPublish(host));
  tabs.append(tSorties, tMoi, tPub);
  body.append(tabs, host);

  tSorties.classList.add('on');
  openSheet('Cobaturage', body);
  paintList(host);
}

/* ==========================================================================
 * Les sorties proposées
 * ========================================================================== */
async function paintList(host) {
  clear(host);
  host.append(el('p', 'tiny', 'Chargement…'));

  let data;
  try {
    data = await sync.apiCall('/api/crew/trips');
  } catch (e) {
    clear(host);
    host.append(el('p', 'c-red', msg(e)));
    return;
  }

  clear(host);
  if (!data.trips.length) {
    host.append(el('p', 'tiny', 'Aucune sortie proposée pour le moment. Tu peux en publier une depuis l’onglet « Proposer ».'));
    return;
  }

  for (const t of data.trips) host.append(tripCard(t, () => paintList(host)));
}

function tripCard(t, refresh) {
  const c = el('div', 'card crew-trip');

  const head = el('div', 'crew-head');
  const left = el('div');
  left.append(el('div', 'crew-port', t.port));
  left.append(el('div', 'tiny c-dim', `${dt(t.departsAt)} · ${t.hours} h`));
  head.append(left);
  head.append(el('span', 'crew-share', cob.euros(t.shareC)));
  c.append(head);

  const meta = el('div', 'crew-meta');
  meta.append(el('span', null, `⛵ ${t.capitaine.bateau}`));
  meta.append(stars(t.capitaine.note));
  meta.append(el('span', null, `${t.seats - t.taken}/${t.seats} place${t.seats > 1 ? 's' : ''}`));
  if (t.fishing) meta.append(el('span', null, t.fishing));
  c.append(meta);

  if (t.notes) c.append(el('p', 'tiny', t.notes));

  /* La mention accompagne le montant, à chaque fois. Elle n'est pas là pour se
   * couvrir : elle dit à l'équipier ce qu'il paie — une part de frais, pas une
   * place sur un bateau à passagers — et donc ce qu'il peut en attendre. */
  c.append(el('p', 'tiny c-dim',
    `Participation aux frais réels de la sortie, partagés entre ${t.seats + 1} personnes, capitaine compris. `
    + 'Ce n’est pas une prestation commerciale ; le règlement se fait à bord.'));

  if (t.mine) {
    c.append(el('span', 'chip', 'Ta sortie'));
  } else if (t.myStatus) {
    const m = { pending: ['warn', 'Demande envoyée'], accepted: ['good', 'Place acceptée'], declined: ['', 'Refusée'], cancelled: ['', 'Annulée'] }[t.myStatus] || ['', t.myStatus];
    c.append(el('span', `chip ${m[0]}`, m[1]));
  } else if (t.taken >= t.seats) {
    c.append(el('span', 'chip', 'Complet'));
  } else {
    c.append(button('Demander une place', 'btn-primary', async () => {
      const message = prompt('Un mot pour le capitaine (facultatif) :', '') ?? '';
      try {
        await sync.apiCall('/api/crew/book', { method: 'POST', body: { tripId: t.id, message } });
        toast('Demande envoyée au capitaine.', 'good');
        refresh();
      } catch (e) { toast(msg(e), 'danger'); }
    }));
  }
  return c;
}

/* ==========================================================================
 * Publier une sortie
 * ========================================================================== */
async function paintPublish(host) {
  clear(host);

  /* La fiche bateau d'abord : une sortie se propose sous un nom de bateau, et
   * la note du capitaine s'y rattache. Sans elle, l'équipier ne voit qu'un
   * identifiant. */
  /* On NOMME ce qui manque. « Renseigne ta fiche bateau » affiché à quelqu'un
   * dont la fiche est visiblement remplie est une impasse : il la rouvre, la
   * voit complète, revient, et lit le même message. Un seul champ manquait —
   * la longueur, avalée par le clavier français dans l'ancien champ numérique. */
  const p = profile.get();
  const missing = [
    !p.boatName && 'le nom du bateau',
    !p.hull && 'le type de coque',
    !p.lengthM && 'la longueur',
  ].filter(Boolean);

  if (missing.length) {
    host.append(el('p', 'tiny',
      `Il manque ${missing.join(' et ')} dans ta fiche bateau. `
      + 'Le nom identifie ta sortie et porte tes avis ; la coque et la longueur '
      + 'décident de ce que l’app appelle une mer praticable — ce qui compte '
      + 'quand tu embarques quelqu’un d’autre.'));
    host.append(button('Compléter la fiche bateau', 'btn-primary', async () => {
      const { openBoatForm } = await import('./boat.js');
      closeSheet();
      openBoatForm({ onSaved: () => openCrew() });
    }));
    return;
  }

  if (!(await idb.get('kv', 'crewTermsAt'))) {
    host.append(terms(() => paintPublish(host)));
    return;
  }

  const draft = {
    port: places.home?.()?.name || '',
    departsAt: '', hours: 5, seats: 2, fishing: '', notes: '',
    costs: { fuel: 0, port: 0, bait: 0, food: 0 },
  };

  const f = (label, hint, input) => {
    const d = el('div', 'field');
    d.append(el('label', null, label));
    d.append(input);
    if (hint) d.append(el('div', 'tiny c-dim', hint));
    return d;
  };
  const inp = (type, val, on, attrs = {}) => {
    const i = document.createElement('input');
    i.type = type;
    i.value = val ?? '';
    Object.assign(i, attrs);
    i.addEventListener('input', () => on(i.value));
    return i;
  };

  host.append(f('Port de départ', null, inp('text', draft.port, (v) => { draft.port = v; })));
  host.append(f('Départ', null, inp('datetime-local', '', (v) => { draft.departsAt = v; paint(); })));
  host.append(f('Durée (h)', null, decimalInput({
    value: draft.hours, placeholder: '5', onInput: (n) => { draft.hours = n ?? 0; },
  })));
  host.append(f('Places pour équipiers', 'Toi non compris — tu es déjà à bord.',
    inp('number', draft.seats, (v) => { draft.seats = Number(v); paint(); }, { min: 1, max: 11 })));
  host.append(f('Type de pêche', null, inp('text', '', (v) => { draft.fishing = v; }, { placeholder: 'Ex. leurres, dérive sur épave' })));

  host.append(el('div', 'field-label', 'Frais réels de la sortie'));
  for (const it of cob.COST_ITEMS) {
    /* Champ décimal maison : « 12,50 » dans un `type="number"` ressort à
     * « 1250 » sur un clavier français, soit mille deux cent cinquante euros
     * de carburant. Le garde-fou de montant aberrant l'aurait attrapé, mais
     * après coup et sans dire pourquoi. */
    host.append(f(it.name, it.hint, decimalInput({
      placeholder: '€',
      onInput: (n) => { draft.costs[it.id] = Math.round((n || 0) * 100); paint(); },
    })));
  }

  /* Les postes refusés sont MONTRÉS, pas tus. Quelqu'un de bonne foi qui ne
   * trouve pas où saisir son assurance finit par la glisser dans « carburant ». */
  const no = el('div', 'crew-refused');
  no.append(el('div', 'tiny', 'Ne se partagent pas :'));
  for (const r of cob.REFUSED_ITEMS) {
    no.append(el('div', 'tiny c-dim', `• ${r.name} — ${r.why}`));
  }
  host.append(no);

  const calc = el('div', 'card crew-calc');
  host.append(calc);
  host.append(f('Précisions', null, inp('text', '', (v) => { draft.notes = v; }, { placeholder: 'Matériel fourni ? point de rendez-vous ?' })));

  const go = button('Publier la sortie', 'btn-primary btn-lg', async () => {
    const s = cob.share(draft.costs, draft.seats);
    if (!s.ok) return void toast(s.reason, 'danger');
    if (!draft.departsAt) return void toast('Indique la date et l’heure du départ.', 'danger');
    try {
      await sync.apiCall('/api/crew/publish', {
        method: 'POST',
        body: { ...draft, departsAt: new Date(draft.departsAt).getTime() },
      });
      toast('Sortie publiée.', 'good');
      openCrew();
    } catch (e) { toast(msg(e), 'danger'); }
  });
  host.append(go);

  function paint() {
    clear(calc);
    const s = cob.share(draft.costs, draft.seats);
    if (!s.ok) {
      calc.append(el('div', 'tiny c-red', s.reason));
      return;
    }
    const row = (k, v, cls) => {
      const r = el('div', 'crew-row');
      r.append(el('span', 'tiny', k));
      r.append(el('span', cls || 'tiny', v));
      calc.append(r);
    };
    row('Frais de la sortie', cob.euros(s.totalC));
    row('Personnes à bord', `${s.headcount} (toi compris)`);
    row('Part par équipier', cob.euros(s.shareC), 'crew-share');
    row('Ta part', cob.euros(s.captainC));
    calc.append(el('p', 'tiny c-dim',
      'Tu paies ta part comme les autres. C’est ce qui distingue un partage de frais d’une prestation — '
      + 'et l’app ne te laissera pas demander davantage.'));
  }
  paint();
}

/** La mention que le capitaine accepte une fois. */
function terms(done) {
  const c = el('div', 'card');
  c.append(el('div', 'field-label', 'Avant de proposer une sortie'));
  const ul = el('div');
  for (const t of cob.CAPTAIN_TERMS) ul.append(el('div', 'tiny crew-term', `• ${t}`));
  c.append(ul);

  /* Le point qui compte vraiment, et qu'on ne noie pas dans la liste : les
   * polices de plaisance excluent les « passagers payants ». En cas
   * d'accident, c'est la première question de l'assureur. */
  c.append(el('p', 'tiny c-red',
    'Vérifie ta police d’assurance. La plupart des contrats de plaisance excluent les passagers '
    + 'payants, et l’appréciation d’une simple participation aux frais n’est pas tranchée. '
    + 'Cette app ne remplace pas l’avis de ton assureur ni celui des affaires maritimes.'));

  c.append(button('J’ai lu et je m’y engage', 'btn-primary', async () => {
    await idb.put('kv', 'crewTermsAt', Date.now());
    done();
  }));
  return c;
}

/* ==========================================================================
 * Ce qui me concerne
 * ========================================================================== */
async function paintMine(host) {
  clear(host);
  host.append(el('p', 'tiny', 'Chargement…'));

  let d;
  try {
    d = await sync.apiCall('/api/crew/mine');
  } catch (e) {
    clear(host);
    host.append(el('p', 'c-red', msg(e)));
    return;
  }
  clear(host);

  if (d.requests.length) {
    host.append(el('div', 'field-label', `Demandes reçues (${d.requests.length})`));
    for (const r of d.requests) {
      const c = el('div', 'card');
      c.append(el('div', 'crew-port', r.pecheur));
      c.append(stars(r.note));
      c.append(el('div', 'tiny c-dim', `${r.port} · ${dt(r.departsAt)} · ${cob.euros(r.shareC)}`));
      if (r.message) c.append(el('p', 'tiny', `« ${r.message} »`));
      const row = el('div', 'btn-row');
      const answer = async (accept) => {
        try {
          await sync.apiCall('/api/crew/decide', { method: 'POST', body: { bookingId: r.bookingId, accept } });
          toast(accept ? 'Place accordée.' : 'Demande refusée.', accept ? 'good' : '');
          paintMine(host);
        } catch (e) { toast(msg(e), 'danger'); }
      };
      row.append(button('Accepter', 'btn-primary', () => answer(true)));
      row.append(button('Refuser', 'btn-ghost', () => answer(false)));
      c.append(row);
      host.append(c);
    }
  }

  host.append(el('div', 'field-label', 'Mes sorties'));
  if (!d.captain.length) host.append(el('p', 'tiny c-dim', 'Tu n’as encore rien proposé.'));
  for (const t of d.captain) {
    const c = tripCard(t, () => paintMine(host));
    if (t.status === 'open' && t.departsAt > Date.now()) {
      c.append(button('Annuler la sortie', 'btn-ghost', async () => {
        try {
          await sync.apiCall('/api/crew/cancel', { method: 'POST', body: { tripId: t.id } });
          toast('Sortie annulée.');
          paintMine(host);
        } catch (e) { toast(msg(e), 'danger'); }
      }));
    }
    if (t.departsAt < Date.now() && t.status !== 'cancelled') c.append(rateBtn(t, t.capitaine.id, host, true));
    host.append(c);
  }

  host.append(el('div', 'field-label', 'Mes embarquements'));
  if (!d.crew.length) host.append(el('p', 'tiny c-dim', 'Aucune place demandée.'));
  for (const t of d.crew) {
    const c = tripCard(t, () => paintMine(host));
    if (t.myStatus === 'accepted' && t.departsAt < Date.now() && t.status !== 'cancelled') {
      c.append(rateBtn(t, t.capitaine.id, host, false));
    }
    host.append(c);
  }
}

/** Noter, une fois la sortie passée. */
function rateBtn(trip, targetId, host, isCaptain) {
  return button(isCaptain ? 'Noter les équipiers' : 'Noter le capitaine', '', () => {
    if (isCaptain) {
      toast('Ouvre la sortie pour noter chaque équipier — bientôt.', '');
      return;
    }
    const s = Number(prompt('Note de 1 à 5 étoiles :', '5'));
    if (!(s >= 1 && s <= 5)) return;
    const comment = prompt('Un mot (facultatif) :', '') ?? '';
    sync.apiCall('/api/crew/review', { method: 'POST', body: { tripId: trip.id, targetId, stars: s, comment } })
      .then(() => { toast('Avis enregistré.', 'good'); paintMine(host); })
      .catch((e) => toast(msg(e), 'danger'));
  });
}

function msg(e) {
  switch (e?.code) {
    case 'invalid_trip': return 'Les frais saisis ne tiennent pas dans le partage — vérifie les montants.';
    case 'trip_in_past': return 'Cette sortie est déjà partie.';
    case 'trip_too_far': return 'Trop loin dans le temps : au-delà d’un mois, la météo n’a plus de sens.';
    case 'trip_full': return 'Plus de place à bord.';
    case 'trip_closed': return 'Cette sortie n’accepte plus de demandes.';
    case 'own_trip': return 'C’est ta propre sortie.';
    case 'already_asked': return 'Tu as déjà demandé une place.';
    case 'already_decided': return 'Cette demande a déjà été traitée.';
    case 'already_reviewed': return 'Tu as déjà noté cette personne pour cette sortie.';
    case 'trip_not_yet': return 'On ne note pas une sortie qui n’a pas encore eu lieu.';
    case 'not_aboard': return 'Tu n’étais pas à bord de cette sortie.';
    case 'forbidden': return 'Ce n’est pas ta sortie.';
    default:
      return e?.message === 'Failed to fetch' ? 'Serveur injoignable.' : (e?.message || 'Erreur.');
  }
}

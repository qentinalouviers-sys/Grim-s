/* ==========================================================================
 * ui/account.js — compte et synchronisation
 * --------------------------------------------------------------------------
 * Le compte est OPTIONNEL et non bloquant : sans lui, l'app tourne à
 * l'identique en local. L'écran rappelle toujours que les données restent sur
 * l'appareil, et qu'à la première connexion le journal local remonte vers le
 * compte (jamais l'inverse).
 * ========================================================================== */

import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import { state } from '../core/store.js';
import * as sync from '../core/sync.js';
import * as fmt from '../core/fmt.js';

export function openAccount() {
  const body = el('div');
  if (sync.isLoggedIn()) {
    renderConnected(body);
  } else {
    renderLogin(body);
  }
  return openSheet('Compte', body);
}

/* --------------------------------------------------------------------------
 * Connecté : état + actions
 * ------------------------------------------------------------------------ */
function renderConnected(body) {
  const user = sync.currentUser();

  body.append(el('div', 'list-title', 'Connecté'));
  body.append(el('div', 'list-sub', user?.email || ''));

  const status = el('div', 'tiny');
  status.style.marginTop = '10px';
  const paintStatus = () => {
    if (state.syncing) {
      status.textContent = 'Synchronisation en cours…';
    } else if (state.lastSyncAt) {
      status.textContent = `Dernière synchro il y a ${fmt.age(state.lastSyncAt)}.`;
    } else {
      status.textContent = 'Pas encore synchronisé.';
    }
  };
  paintStatus();

  const acts = el('div', 'btn-row');
  acts.append(button('🔄 Synchroniser maintenant', 'btn-primary', async () => {
    const btn = acts.firstChild;
    btn.disabled = true;
    const r = await sync.sync();
    btn.disabled = false;
    paintStatus();
    if (r.ok) toast(`Synchro OK — ${r.pushed} envoyé(s), ${r.pulled} reçu(s)`, 'good');
    else if (r.reason === 'offline') toast('Hors ligne : la synchro attendra le réseau.', 'warn');
    else if (r.reason === 'noauth') toast('Non connecté.', 'warn');
    else toast(`Synchro impossible : ${r.error || 'erreur'}`, 'danger');
  }));
  acts.append(button('Se déconnecter', 'btn-ghost', async () => {
    await sync.logout();
    closeSheet();
    toast('Déconnecté. Tes données restent sur ce téléphone.', '');
  }));
  body.append(acts);

  body.append(el('p', 'tiny',
    'La déconnexion ne supprime rien : tes données restent sur cet appareil. Elles ne seront simplement plus synchronisées.'));

  sync.onDone(paintStatus);
}

/* --------------------------------------------------------------------------
 * Non connecté : connexion / inscription
 * ------------------------------------------------------------------------ */
function renderLogin(body) {
  /* Deux temps pour l'inscription, un seul pour la connexion.
   *
   * L'ancien écran soumettait DÈS le premier appui sur « Créer un compte » :
   * il révélait le champ « nom du bateau » et envoyait la requête dans la même
   * fonction. Personne n'a jamais pu renseigner ce champ, et un compte se
   * créait sur un mot de passe tapé une seule fois — sans confirmation et sans
   * réinitialisation possible, une faute de frappe fermait le compte à vie. */
  let creating = false;

  const mkField = (labelTxt, type, opts = {}) => {
    const f = el('div', 'field');
    f.append(el('label', null, labelTxt));
    const i = document.createElement('input');
    i.type = type;
    Object.assign(i, opts);
    f.append(i);
    return { field: f, input: i };
  };

  /* `autocomplete` et `name` : sans eux, aucun gestionnaire de mots de passe
   * ne propose de remplir ni d'enregistrer. Sur un téléphone où le mot de
   * passe est long et l'écran mouillé, c'est la différence entre se connecter
   * et renoncer. */
  const eMail = mkField('E-mail', 'email', {
    name: 'email', autocomplete: 'email', inputMode: 'email',
    autocapitalize: 'none', autocorrect: 'off', placeholder: 'toi@exemple.fr',
  });
  const ePass = mkField('Mot de passe', 'password', {
    name: 'password', autocomplete: 'current-password', placeholder: '8 caractères minimum',
  });
  const ePass2 = mkField('Confirme le mot de passe', 'password', {
    name: 'password2', autocomplete: 'new-password',
  });
  const eName = mkField('Nom du bateau (facultatif)', 'text', {
    name: 'nickname', autocomplete: 'off', autocapitalize: 'words', placeholder: 'Ex. Grim’s',
  });
  ePass2.field.hidden = true;
  eName.field.hidden = true;

  body.append(eMail.field, ePass.field, ePass2.field, eName.field);

  const err = el('div', 'tiny c-red');
  err.style.minHeight = '1.2em';
  body.append(err);

  const primary = button('Se connecter', 'btn-primary btn-lg', () => submit());
  const secondary = button('Créer un compte', 'btn-lg', () => {
    if (!creating) {
      // Premier appui : on ouvre le formulaire d'inscription. On ne soumet
      // pas — il reste deux champs à remplir.
      creating = true;
      ePass2.field.hidden = false;
      eName.field.hidden = false;
      ePass.input.autocomplete = 'new-password';
      ePass.input.placeholder = '8 caractères minimum';
      primary.hidden = true;
      secondary.textContent = 'Créer le compte';
      err.textContent = '';
      eMail.input.focus();
      return;
    }
    submit();
  });
  const row = el('div', 'btn-row');
  row.append(primary, secondary);
  body.append(row);

  /* Entrée valide, sur les trois champs. Le clavier d'un téléphone affiche
   * « OK » ou « Go » : sans écouteur, cette touche ne faisait rien et il
   * fallait replier le clavier pour atteindre le bouton. */
  for (const i of [eMail.input, ePass.input, ePass2.input, eName.input]) {
    i.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
  }

  /* ---- Mot de passe oublié ---------------------------------------------- */
  const forgot = button('Mot de passe oublié', 'btn-sm', async () => {
    const mail = eMail.input.value.trim();
    if (!mail) { err.textContent = 'Renseigne d’abord ton e-mail.'; return; }
    forgot.disabled = true;
    try {
      const r = await sync.requestPasswordReset(mail);
      if (r.unsupported) {
        err.textContent = '';
        toast('La réinitialisation n’est pas encore en service sur le serveur.', 'warn', 5000);
      } else {
        // Réponse volontairement identique que le compte existe ou non : dire
        // « cet e-mail est inconnu » révèle qui a un compte.
        toast('Si un compte existe pour cet e-mail, un lien vient de partir.', 'good', 5000);
      }
    } catch (ex) {
      err.textContent = message(ex);
    } finally {
      forgot.disabled = false;
    }
  });
  forgot.style.marginTop = '10px';
  body.append(forgot);

  async function submit() {
    const mail = eMail.input.value.trim();
    const pass = ePass.input.value;
    err.textContent = '';

    if (!mail || !pass) { err.textContent = 'Renseigne l’e-mail et le mot de passe.'; return; }
    // Un contrôle sommaire, côté client : le serveur reste juge. Il évite
    // seulement l'aller-retour pour une adresse manifestement incomplète.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(mail)) {
      err.textContent = 'Cette adresse e-mail n’a pas l’air valide.';
      return;
    }
    if (creating) {
      /* Huit caractères et non six : ce mot de passe protège un journal de
       * pêche et des marques relevées au sondeur, et il n'y a pas de second
       * facteur. Six caractères se cassent hors ligne en quelques minutes. */
      if (pass.length < 8) { err.textContent = 'Mot de passe : 8 caractères minimum.'; return; }
      if (pass !== ePass2.input.value) { err.textContent = 'Les deux mots de passe diffèrent.'; return; }
    }

    // Le bouton DÉCLENCHEUR est désactivé, pas « le premier .btn-primary » :
    // sur le chemin « se connecter », l'ancien code désactivait l'autre bouton
    // et laissait celui-ci recevoir un deuxième appui — donc deux requêtes.
    const btn = creating ? secondary : primary;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = creating ? 'Création…' : 'Connexion…';
    try {
      if (creating) {
        await sync.register(mail, pass, eName.input.value.trim() || null);
        toast('Compte créé — synchronisation de tes données…', 'good');
      } else {
        await sync.login(mail, pass);
        toast('Connecté — synchronisation…', 'good');
      }
      closeSheet();
    } catch (ex) {
      err.textContent = message(ex);
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  body.append(el('p', 'tiny',
    'Un compte sert à retrouver ton journal, tes marques et tes sondes sur un autre téléphone, '
    + 'et à les sauvegarder. À la première connexion, ce qui est déjà sur ce téléphone est '
    + 'envoyé vers le compte — jamais perdu ni écrasé. Sans compte, tout reste ici, comme avant.'));
}

function message(ex) {
  switch (ex?.code) {
    case 'invalid_email': return 'E-mail invalide.';
    case 'weak_password': return 'Mot de passe trop court — 8 caractères minimum.';
    case 'rate_limited': return 'Trop de tentatives. Attends une minute.';
    case 'account_locked': return 'Compte bloqué après trop d’essais. Réessaie plus tard.';
    case 'email_taken': return 'Un compte existe déjà avec cet e-mail.';
    case 'bad_credentials': return 'E-mail ou mot de passe incorrect.';
    case 'timeout': return 'Pas de réponse du serveur. Réessaie avec du réseau.';
    default: return ex?.message === 'Failed to fetch' ? 'Serveur injoignable. Vérifie le réseau.' : (ex?.message || 'Erreur.');
  }
}

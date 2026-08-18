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

  /* Administration : l'entrée n'apparaît que si le SERVEUR reconnaît ce compte
   * comme administrateur. On ne le déduit pas d'un champ local — un client qui
   * en déciderait seul serait trivial à convaincre du contraire. Ce que la
   * réponse change, c'est l'affichage ; les routes, elles, refusent de toute
   * façon. Et si le réseau manque, l'entrée ne s'affiche pas : administrer
   * sans serveur n'a de toute manière aucun sens. */
  const adminHost = el('div');
  body.append(adminHost);
  sync.whoAmI().then((me) => {
    if (!me?.admin) return;
    const row = el('div', 'btn-row');
    row.append(button('🛠 Panneau d’administration', 'btn-ghost', async () => {
      const { openAdmin } = await import('./admin.js');
      openAdmin();
    }));
    adminHost.append(row);
  });

  body.append(el('p', 'tiny',
    'La déconnexion ne supprime rien : tes données restent sur cet appareil. Elles ne seront simplement plus synchronisées.'));

  /* Le même texte qu'à l'inscription, consultable à tout moment.
   *
   * Une mention qu'on ne voit qu'une fois, le jour où l'on crée son compte, ne
   * vaut pas grand-chose six mois plus tard — et les comptes créés AVANT elle
   * ne l'ont jamais vue du tout. Repliée par défaut : présente pour qui la
   * cherche, sans encombrer un écran qu'on ouvre pour synchroniser. */
  const det = el('details', 'card');
  det.append(el('summary', 'field-label', 'Ce que deviennent mes relevés'));
  det.append(el('p', 'tiny',
    'Les prises que tu enregistres — espèce, taille, position, marée, vent, fond — '
    + 'sont mises en commun pour construire le modèle de prévision de l’app. Elles '
    + 'sont rattachées à ton compte et l’administrateur du service peut les '
    + 'consulter. Ton carnet de sondes et tes marques suivent la même règle. Rien '
    + 'n’est vendu, rien n’est publié sous ton nom.'));
  det.append(el('p', 'tiny',
    'Tu peux à tout moment récupérer l’intégralité de tes données avec « Exporter », '
    + 'ou supprimer ton compte : la suppression efface aussi tout ce que tu as déposé '
    + 'sur le serveur, y compris du fonds commun.'));
  body.append(det);

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
  /* Le code d'invitation n'apparaît qu'après un refus du serveur. Sur une
   * installation ouverte, il n'y a rien à demander — et un champ vide de plus
   * sur un formulaire d'inscription se lit comme une obligation. */
  const eInvite = mkField('Code d’invitation', 'text', {
    name: 'invite', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
  });
  ePass2.field.hidden = true;
  eName.field.hidden = true;
  eInvite.field.hidden = true;

  body.append(eMail.field, ePass.field, ePass2.field, eName.field, eInvite.field);

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

    /* Le mot de passe est étiré sur l'appareil avant de partir (`core/kdf.js`).
     * Sur un téléphone ancien c'est plusieurs secondes, pendant lesquelles rien
     * ne circule encore : afficher « Connexion… » ferait chercher un problème
     * de réseau là où il n'y en a pas. On dit ce qui se passe vraiment. */
    btn.textContent = 'Chiffrement…';
    const offStretch = sync.onStretched(() => {
      btn.textContent = creating ? 'Création…' : 'Connexion…';
    });

    try {
      if (creating) {
        await sync.register(mail, pass, eName.input.value.trim() || null,
          eInvite.input.value.trim() || null);
        toast('Compte créé — synchronisation de tes données…', 'good');
      } else {
        await sync.login(mail, pass);
        toast('Connecté — synchronisation…', 'good');
      }
      closeSheet();
    } catch (ex) {
      /* Ce serveur n'accepte que les invités : on découvre le champ plutôt que
       * de renvoyer un message sur une case qui n'existe pas à l'écran. */
      if (ex?.code === 'invite_required' || ex?.code === 'invite_invalid') {
        eInvite.field.hidden = false;
        eInvite.input.focus();
      }
      err.textContent = message(ex);
      btn.disabled = false;
      btn.textContent = label;
    } finally {
      offStretch();
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
    /* Le serveur a reçu autre chose qu'une clé dérivée : cette version de
     * l'app n'a pas préparé le mot de passe comme il faut. Rafraîchir la page
     * récupère la version à jour — le service worker la remplace au relancement. */
    case 'client_outdated': return 'Version de l’app trop ancienne. Ferme-la et rouvre-la pour la mettre à jour.';
    case 'crypto_unavailable': return 'Ce navigateur ne peut pas sécuriser le mot de passe (page non chiffrée ?).';
    case 'rate_limited': return 'Trop de tentatives. Attends une minute.';
    case 'account_locked': return 'Compte bloqué après trop d’essais. Réessaie plus tard.';
    case 'email_taken': return 'Un compte existe déjà avec cet e-mail.';
    case 'invite_required': return 'Ce serveur est sur invitation. Saisis le code qu’on t’a donné.';
    case 'invite_invalid': return 'Ce code d’invitation n’est pas le bon.';
    case 'bad_credentials': return 'E-mail ou mot de passe incorrect.';
    case 'timeout': return 'Pas de réponse du serveur. Réessaie avec du réseau.';
    default: return ex?.message === 'Failed to fetch' ? 'Serveur injoignable. Vérifie le réseau.' : (ex?.message || 'Erreur.');
  }
}

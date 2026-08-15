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
  const mode = { create: false };

  const fEmail = el('div', 'field');
  fEmail.append(el('label', null, 'E-mail'));
  const email = document.createElement('input');
  email.type = 'email';
  email.inputMode = 'email';
  email.autocapitalize = 'none';
  email.autocorrect = 'off';
  email.placeholder = 'toi@exemple.fr';
  fEmail.append(email);

  const fPass = el('div', 'field');
  fPass.append(el('label', null, 'Mot de passe'));
  const password = document.createElement('input');
  password.type = 'password';
  password.placeholder = '6 caractères minimum';
  fPass.append(password);

  const nameField = el('div', 'field');
  nameField.append(el('label', null, 'Nom du bateau (facultatif)'));
  const name = document.createElement('input');
  name.type = 'text';
  name.autocapitalize = 'words';
  name.placeholder = 'Ex. Grim’s';
  nameField.append(name);
  nameField.hidden = true;

  body.append(fEmail, fPass, nameField);

  const err = el('div', 'tiny');
  err.style.color = 'var(--danger, #ff6b6b)';
  err.style.minHeight = '1.2em';
  body.append(err);

  const submit = async () => {
    const e = email.value.trim();
    const p = password.value;
    err.textContent = '';
    if (!e || !p) { err.textContent = 'Renseigne l’e-mail et le mot de passe.'; return; }
    if (p.length < 6) { err.textContent = 'Mot de passe : 6 caractères minimum.'; return; }

    const btn = body.querySelector('.btn-primary');
    btn.disabled = true;
    try {
      if (mode.create) {
        await sync.register(e, p, name.value.trim() || null);
        toast('Compte créé — synchronisation de tes données…', 'good');
      } else {
        await sync.login(e, p);
        toast('Connecté — synchronisation…', 'good');
      }
      closeSheet();
    } catch (ex) {
      err.textContent = message(ex);
      btn.disabled = false;
    }
  };

  const row = el('div', 'btn-row');
  row.append(button('Créer un compte', 'btn-primary', () => { mode.create = true; nameField.hidden = false; submit(); }));
  row.append(button('Se connecter', '', () => { mode.create = false; nameField.hidden = true; submit(); }));
  body.append(row);

  body.append(el('p', 'tiny',
    'Un compte sert à retrouver ton journal et tes marques sur un autre téléphone, et à les sauvegarder. À la première connexion, ce qui est déjà sur ce téléphone est envoyé vers le compte — jamais perdu ni écrasé. Sans compte, tout reste ici, comme avant.'));
}

function message(ex) {
  switch (ex?.code) {
    case 'invalid_email': return 'E-mail invalide.';
    case 'weak_password': return 'Mot de passe trop court.';
    case 'email_taken': return 'Un compte existe déjà avec cet e-mail.';
    case 'bad_credentials': return 'E-mail ou mot de passe incorrect.';
    case 'timeout': return 'Pas de réponse du serveur. Réessaie avec du réseau.';
    default: return ex?.message === 'Failed to fetch' ? 'Serveur injoignable. Vérifie le réseau.' : (ex?.message || 'Erreur.');
  }
}

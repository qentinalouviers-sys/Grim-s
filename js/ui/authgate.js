/* ==========================================================================
 * ui/authgate.js — le portail de connexion
 * --------------------------------------------------------------------------
 * Première page de l'app : on ne rentre pas sans compte.
 *
 * DEUX RÈGLES QUI NE SE NÉGOCIENT PAS
 *
 * 1. La porte se juge sur la SESSION LOCALE, jamais sur le serveur. Une
 *    session déjà enregistrée ouvre l'app immédiatement, sans réseau et sans
 *    attendre quoi que ce soit. Interroger le serveur au démarrage rendrait
 *    l'app inutilisable au large — c'est-à-dire précisément là où elle sert,
 *    et où le MOB et le SOS doivent répondre.
 *
 * 2. Le portail est visible AVANT que le JavaScript ne tourne (il est dans
 *    index.html, affiché par défaut) et disparaît si la session existe. Fait
 *    dans l'autre sens, l'utilisateur connecté verrait l'écran de connexion
 *    clignoter à chaque lancement, et le non connecté verrait l'app une
 *    fraction de seconde avant d'en être sorti.
 *
 * Le fond est dessiné en canvas, à la main. Pas de bibliothèque 3D : ce
 * projet n'a aucune dépendance, tout est préchargé pour fonctionner hors
 * ligne, et quelques centaines de kilooctets pour un décor d'écran de
 * connexion se paieraient à chaque premier lancement, sur le quai, avec une
 * barre de réseau.
 * ========================================================================== */

import * as sync from '../core/sync.js';
import { on } from '../core/store.js';
import { APP_VERSION } from '../core/build.js';

const $ = (id) => document.getElementById(id);

let anim = null;
let resolveEntry = null;

/* ==========================================================================
 * Le fond : houle et balayage de sondeur
 * --------------------------------------------------------------------------
 * Trois trains de houle superposés de périodes différentes — c'est ce qui
 * donne à la mer son irrégularité, une sinusoïde seule fait tôle ondulée — et
 * un balayage lent qui traverse, comme l'écho d'un sondeur.
 * ========================================================================== */
class Sea {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = 0;
    this.raf = 0;

    /* Un appareil qui demande moins d'animation en reçoit moins : réglage
     * d'accessibilité, et accessoirement de batterie. On dessine alors une
     * seule image fixe au lieu d'une boucle. */
    this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    if (this.still) this.draw();
  }

  start() {
    if (this.still || this.raf) return;
    const loop = () => {
      this.t += 1 / 60;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  draw() {
    const { ctx, w, h, t } = this;
    ctx.clearRect(0, 0, w, h);

    /* --- Les trains de houle ------------------------------------------- */
    const bands = [
      { y: 0.62, amp: 16, len: 260, spd: 0.22, a: 0.10 },
      { y: 0.70, amp: 22, len: 380, spd: -0.15, a: 0.09 },
      { y: 0.80, amp: 30, len: 520, spd: 0.10, a: 0.08 },
    ];

    for (const b of bands) {
      const base = h * b.y;
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, base);
      for (let x = 0; x <= w; x += 6) {
        // Deux composantes par bande : la seconde, de période irrationnelle
        // par rapport à la première, empêche le motif de se répéter à l'œil.
        const y = base
          + Math.sin((x / b.len) + t * b.spd) * b.amp
          + Math.sin((x / (b.len * 0.37)) + t * b.spd * 1.7) * b.amp * 0.35;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();

      const g = ctx.createLinearGradient(0, base - b.amp, 0, h);
      g.addColorStop(0, `rgba(47,129,247,${b.a * 1.6})`);
      g.addColorStop(1, 'rgba(47,129,247,0)');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.strokeStyle = `rgba(120,180,255,${b.a * 1.4})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* --- Le balayage du sondeur ---------------------------------------- */
    if (!this.still) {
      const period = 9;
      const p = (t % period) / period;
      const x = p * (w + 160) - 80;
      const g = ctx.createLinearGradient(x - 70, 0, x + 70, 0);
      g.addColorStop(0, 'rgba(120,200,255,0)');
      g.addColorStop(0.5, 'rgba(120,200,255,0.055)');
      g.addColorStop(1, 'rgba(120,200,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 70, 0, 140, h);
    }
  }

  destroy() {
    this.stop();
    this.ro.disconnect();
  }
}

/* ==========================================================================
 * Le portail
 * ========================================================================== */

/**
 * Décide si l'app peut s'ouvrir, et bloque tant que non.
 *
 * @returns {Promise<void>} résolue quand une session locale existe — soit
 *   qu'elle existait déjà, soit que l'utilisateur vient de se connecter.
 */
export function requireAuth() {
  const gate = $('auth-gate');

  if (sync.isLoggedIn()) {
    dismiss(gate);
    return Promise.resolve();
  }

  reveal(gate);
  return new Promise((resolve) => {
    resolveEntry = () => {
      dismiss(gate);
      resolve();
    };
  });
}

/**
 * Réaffiche le portail après une déconnexion ou une session expirée.
 *
 * Sans cela, se déconnecter laissait l'app ouverte et vide : les écrans
 * restaient là, la synchro échouait en silence, et rien ne disait qu'il
 * fallait se reconnecter.
 */
export function lock() {
  const gate = $('auth-gate');
  if (!gate || !gate.hidden) return;

  /* ON RÉARME LA SORTIE.
   *
   * `resolveEntry` est posé par `requireAuth()` au démarrage, et consommé à la
   * première connexion. Sans cette ligne, une déconnexion rouvrait le portail
   * avec une sortie déjà consommée : le formulaire acceptait la connexion, la
   * session s'ouvrait pour de bon… et le portail restait affiché par-dessus.
   * L'app devenait inaccessible jusqu'au rechargement, et rien à l'écran ne
   * disait quoi faire. */
  resolveEntry = () => dismiss(gate);
  reveal(gate);
}

function dismiss(gate) {
  if (!gate) return;
  gate.classList.add('is-leaving');
  // On laisse la transition finir avant de retirer l'élément du flux, sinon
  // l'app apparaît d'un coup sec au milieu du fondu.
  setTimeout(() => {
    gate.hidden = true;
    gate.classList.remove('is-leaving');
    anim?.destroy();
    anim = null;
  }, 260);
}

function reveal(gate) {
  if (!gate) return;
  gate.hidden = false;
  gate.classList.remove('is-leaving');
  const ver = $('auth-ver');
  if (ver) ver.textContent = APP_VERSION;
  if (!anim) {
    anim = new Sea($('auth-sea'));
    anim.start();
  }
  build(gate);
  // Le focus au clavier ne se pose qu'après l'affichage, et pas sur mobile :
  // faire monter le clavier avant que l'écran soit lisible désoriente.
  if (window.matchMedia?.('(pointer: fine)')?.matches) {
    setTimeout(() => $('ag-email')?.focus(), 320);
  }
}

let built = false;

function build(gate) {
  if (built) return;
  built = true;

  const form = gate.querySelector('.ag-form');
  const email = $('ag-email');
  const pass = $('ag-pass');
  const pass2 = $('ag-pass2');
  const name = $('ag-name');
  const invite = $('ag-invite');
  const err = $('ag-err');
  const primary = $('ag-go');
  const toggle = $('ag-toggle');
  const title = $('ag-mode-title');

  let creating = false;

  const fieldOf = (input) => input.closest('.ag-field');

  const setMode = (next) => {
    creating = next;
    fieldOf(pass2).hidden = !creating;
    fieldOf(name).hidden = !creating;
    /* La mention sur les données n'apparaît qu'à la création : c'est le seul
     * instant où elle informe une décision. La répéter à chaque connexion la
     * transformerait en bandeau qu'on apprend à ne plus lire. Elle reste
     * consultable ensuite depuis Réglages. */
    $('ag-consent').hidden = !creating;
    pass.autocomplete = creating ? 'new-password' : 'current-password';
    primary.textContent = creating ? 'Créer le compte' : 'Se connecter';
    toggle.textContent = creating ? 'J’ai déjà un compte' : 'Créer un compte';
    title.textContent = creating ? 'Nouveau compte' : 'Connexion';
    err.textContent = '';
  };

  toggle.addEventListener('click', () => setMode(!creating));
  setMode(false);

  /* Le lien « mot de passe oublié » ne promet rien qu'il ne tienne : si le
   * serveur n'a pas d'expéditeur configuré, il le dit franchement au lieu
   * d'afficher « un message est parti » sur un message qui ne partira pas. */
  $('ag-forgot').addEventListener('click', async () => {
    const mail = email.value.trim();
    if (!mail) { err.textContent = 'Saisis d’abord ton adresse e-mail.'; email.focus(); return; }
    const btn = $('ag-forgot');
    btn.disabled = true;
    try {
      const r = await sync.requestPasswordReset(mail);
      err.textContent = r.unsupported
        ? 'La réinitialisation n’est pas encore en service sur le serveur.'
        : 'Si un compte existe pour cette adresse, un lien vient de partir.';
    } catch (ex) {
      err.textContent = message(ex);
    } finally {
      btn.disabled = false;
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  async function submit() {
    const mail = email.value.trim();
    const pw = pass.value;

    if (!mail || !pw) { err.textContent = 'Renseigne l’e-mail et le mot de passe.'; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(mail)) {
      err.textContent = 'Cette adresse e-mail n’a pas l’air valide.';
      return;
    }
    if (creating) {
      /* Huit caractères et non six. Le serveur ne peut plus le vérifier — il
       * ne reçoit que la clé dérivée, jamais le mot de passe — donc ce
       * contrôle-ci est le seul qui existe. */
      if (pw.length < 8) { err.textContent = 'Mot de passe : 8 caractères minimum.'; return; }
      if (pw !== pass2.value) { err.textContent = 'Les deux mots de passe diffèrent.'; return; }
    }

    /* Hors ligne et sans session : inutile de laisser croire que ça peut
     * marcher. On le dit avant de perdre quinze secondes en délai d'attente. */
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      err.textContent = 'Pas de réseau. La première connexion en demande un ; ensuite l’app fonctionne hors ligne.';
      return;
    }

    const label = primary.textContent;
    primary.disabled = true;
    toggle.disabled = true;

    /* L'étirement du mot de passe tourne sur l'appareil et peut prendre
     * plusieurs secondes sur un téléphone ancien. Pendant ce temps rien ne
     * circule : afficher « Connexion… » ferait chercher un problème de réseau
     * là où il n'y en a pas. */
    primary.textContent = 'Chiffrement…';
    const offStretch = sync.onStretched(() => {
      primary.textContent = creating ? 'Création…' : 'Connexion…';
    });

    try {
      if (creating) {
        await sync.register(mail, pw, name.value.trim() || null, invite.value.trim() || null);
      } else {
        await sync.login(mail, pw);
      }
      resolveEntry?.();
      resolveEntry = null;
    } catch (ex) {
      if (ex?.code === 'invite_required' || ex?.code === 'invite_invalid') {
        fieldOf(invite).hidden = false;
        invite.focus();
      }
      err.textContent = message(ex);
      primary.disabled = false;
      toggle.disabled = false;
      primary.textContent = label;
    } finally {
      offStretch();
    }
  }
}

function message(ex) {
  switch (ex?.code) {
    case 'invalid_email': return 'E-mail invalide.';
    case 'weak_password': return 'Mot de passe trop court — 8 caractères minimum.';
    case 'client_outdated': return 'Version de l’app trop ancienne. Ferme-la et rouvre-la pour la mettre à jour.';
    case 'crypto_unavailable': return 'Ce navigateur ne peut pas sécuriser le mot de passe (page non chiffrée ?).';
    case 'rate_limited': return 'Trop de tentatives. Attends une minute.';
    case 'account_locked': return 'Compte bloqué après trop d’essais. Réessaie plus tard.';
    case 'email_taken': return 'Un compte existe déjà avec cet e-mail.';
    case 'bad_credentials': return 'E-mail ou mot de passe incorrect.';
    case 'invite_required': return 'Ce serveur est sur invitation. Saisis le code qu’on t’a donné.';
    case 'invite_invalid': return 'Ce code d’invitation n’est pas le bon.';
    case 'timeout': return 'Pas de réponse du serveur. Réessaie avec du réseau.';
    default:
      return ex?.message === 'Failed to fetch'
        ? 'Serveur injoignable. Vérifie le réseau.'
        : (ex?.message || 'Erreur.');
  }
}

/* Déconnexion et session expirée ramènent au portail. Une app ouverte mais
 * déconnectée n'a plus rien à montrer : ses écrans se videraient un par un
 * sans que rien n'explique pourquoi.
 *
 * Et l'inverse : dès qu'une session existe, le portail s'efface — d'où qu'elle
 * vienne. C'est la seconde moitié du filet, celle qui garantit qu'on ne peut
 * pas rester bloqué devant un formulaire qui vient pourtant de réussir. */
on('account:changed', (user) => {
  if (!user) lock();
  else {
    const gate = $('auth-gate');
    if (gate && !gate.hidden) dismiss(gate);
  }
});
on('account:expired', () => lock());

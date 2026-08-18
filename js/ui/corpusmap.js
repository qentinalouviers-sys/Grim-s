/* ==========================================================================
 * ui/corpusmap.js — le fonds de données, sur une carte
 * --------------------------------------------------------------------------
 * L'écran qui donne son sens à la collecte : toutes les prises de tous les
 * comptes, posées sur la carte, filtrables par espèce, par période et par
 * pêcheur. C'est là qu'on voit si le corpus tient debout — où l'on pêche
 * vraiment, quelles espèces reviennent, et surtout où il n'y a RIEN, ce qu'un
 * tableau de chiffres ne montre jamais.
 *
 * TROIS PARTIS PRIS D'AFFICHAGE
 *
 * 1. Des cercles, pas des épingles. À deux mille points, des marqueurs Leaflet
 *    classiques écroulent le rendu sur un téléphone ; `L.circleMarker` sur un
 *    canevas tient. C'est aussi plus honnête : un point de pêche a une
 *    imprécision, une épingle prétend le contraire.
 *
 * 2. La couleur dit l'ESPÈCE, jamais le pêcheur. On regarde ces points pour
 *    comprendre le poisson ; colorer par compte inviterait à lire l'écran
 *    comme une surveillance, ce qui n'est pas sa raison d'être.
 *
 * 3. Une troncature s'ANNONCE. Le serveur plafonne à 5 000 points ; sans
 *    bandeau, on lirait une zone vide en croyant qu'elle est vide, alors
 *    qu'elle est seulement au-delà du plafond.
 *
 * La carte est construite ici et non réutilisée depuis `views/map.js` : celle
 * de l'app porte des couches, une trace, une veille de mouillage et un état
 * qui n'ont rien à faire dans un écran d'administration. Deux cartes qui font
 * deux métiers valent mieux qu'une carte qui essaie de faire les deux.
 * ========================================================================== */

import { el, clear, button, toast, openSheet } from './dom.js';
import { loadLeaflet } from './leaflet.js';
import * as sync from '../core/sync.js';

const nf = new Intl.NumberFormat('fr-FR');

/* Palette : lisible sur fond de carte clair comme sombre, et distinguable en
 * vision dichromate — les rouges et verts ne se répondent pas. */
const COULEURS = [
  '#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#e599f7',
  '#ff922b', '#22b8cf', '#f783ac', '#a9e34b', '#9775fa',
];
const COULEUR_AUTRE = '#adb5bd';

/** Même espèce → même couleur d'une ouverture à l'autre. */
function palette(especes) {
  const m = new Map();
  especes.slice(0, COULEURS.length).forEach((e, i) => m.set(e.id, COULEURS[i]));
  return (id) => m.get(id) || COULEUR_AUTRE;
}

const PERIODES = [
  { id: 'tout', label: 'Tout', jours: null },
  { id: 'an', label: '12 mois', jours: 365 },
  { id: 'saison', label: '3 mois', jours: 90 },
  { id: 'mois', label: '30 jours', jours: 30 },
];

const TYPES = [
  { id: 'catches', label: 'Prises' },
  { id: 'soundings', label: 'Sondes' },
  { id: 'spots', label: 'Marques' },
];

export async function openCorpusMap(comptes = []) {
  const body = el('div');
  body.append(el('p', 'tiny', 'Chargement du fonds…'));
  openSheet('Carte du fonds', body);

  let stats;
  try {
    stats = await sync.apiCall('/api/admin/corpus/stats');
  } catch (e) {
    clear(body);
    body.append(el('p', 'c-red', e?.code === 'forbidden'
      ? 'Ce compte n’administre pas ce serveur.'
      : `Impossible de charger : ${e?.message || 'erreur'}`));
    return;
  }

  /* L'identifiant de compte est ce que le serveur rend ; le nom du bateau est
   * ce qu'un humain lit. La correspondance se fait ICI, à partir de la liste
   * déjà chargée par le panneau — ce qui évite de faire voyager des adresses
   * avec chaque point de la carte. */
  const nomDe = new Map(comptes.map((c) => [c.id, c.bateau || c.email || c.id]));

  clear(body);
  render(body, stats, nomDe);
}

function render(body, stats, nomDe) {
  const couleurDe = palette(stats.especes);

  /* --- Ce que vaut le corpus ------------------------------------------ */
  const resume = el('div', 'card');
  resume.append(el('div', 'field-label', 'Le fonds'));
  const grille = el('div', 'admin-grid');
  const tuile = (v, l, aide) => {
    const t = el('div', 'admin-tile');
    t.append(el('div', 'admin-tile-val', nf.format(v)));
    t.append(el('div', 'admin-tile-lab', l));
    if (aide) t.title = aide;
    return t;
  };
  grille.append(
    tuile(stats.prises.total, 'prises'),
    /* Le chiffre qui compte réellement pour entraîner quoi que ce soit. Une
     * prise sans position ni relevé de conditions ne porte aucune variable
     * explicative : elle gonfle le total et n'apprend rien. */
    tuile(stats.prises.exploitables, 'exploitables',
      'Prises portant à la fois une position et le relevé des conditions.'),
    tuile(stats.sondes.total, 'sondes'),
    tuile(stats.prises.contributeurs, 'contributeurs'),
  );
  resume.append(grille);

  const perte = stats.prises.total - stats.prises.exploitables;
  if (perte > 0) {
    resume.append(el('p', 'tiny', `${nf.format(perte)} prise${perte > 1 ? 's' : ''} `
      + 'sans position ou sans relevé de conditions — comptée'
      + `${perte > 1 ? 's' : ''} dans le total, inutilisable`
      + `${perte > 1 ? 's' : ''} pour un modèle.`));
  }
  if (stats.prises.premiere) {
    const d = (ms) => new Date(ms).toLocaleDateString('fr-FR');
    resume.append(el('p', 'tiny', `Du ${d(stats.prises.premiere)} au ${d(stats.prises.derniere)}.`));
  }
  body.append(resume);

  /* --- Les filtres ----------------------------------------------------- */
  const etat = { kind: 'catches', species: '', jours: null, user: '' };

  const filtres = el('div', 'card');
  filtres.append(el('div', 'field-label', 'Afficher'));

  const rangee = (options, actif, onPick) => {
    const r = el('div', 'chip-row');
    const boutons = [];
    options.forEach((o) => {
      const b = button(o.label, `chip${o.id === actif ? ' is-on' : ''}`, () => {
        boutons.forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
        onPick(o);
      });
      boutons.push(b);
      r.append(b);
    });
    return r;
  };

  filtres.append(rangee(TYPES, 'catches', (o) => { etat.kind = o.id; recharger(); }));
  filtres.append(rangee(PERIODES, 'tout', (o) => { etat.jours = o.jours; recharger(); }));

  /* Espèces : seulement celles qui existent réellement dans le fonds. Une
   * liste des espèces connues de l'app afficherait des filtres qui ne rendent
   * jamais rien, et on chercherait longtemps pourquoi. */
  const especeSel = el('select');
  especeSel.className = 'admin-search';
  especeSel.append(new Option('Toutes les espèces', ''));
  for (const e of stats.especes) especeSel.append(new Option(`${e.nom} (${nf.format(e.n)})`, e.id));
  especeSel.addEventListener('change', () => { etat.species = especeSel.value; recharger(); });
  filtres.append(especeSel);

  const compteSel = el('select');
  compteSel.className = 'admin-search';
  compteSel.append(new Option('Tous les pêcheurs', ''));
  for (const c of stats.contributeurs) {
    compteSel.append(new Option(`${nomDe.get(c.uid) || c.uid} — ${nf.format(c.prises)}`, c.uid));
  }
  compteSel.addEventListener('change', () => { etat.user = compteSel.value; recharger(); });
  filtres.append(compteSel);
  body.append(filtres);

  /* --- La carte -------------------------------------------------------- */
  const carte = el('div', 'card');
  const bandeau = el('p', 'tiny', 'Chargement des points…');
  carte.append(bandeau);
  const holder = el('div');
  holder.className = 'corpus-map';
  carte.append(holder);
  const legende = el('div', 'corpus-legend');
  carte.append(legende);
  body.append(carte);

  /* --- Les espèces, en clair ------------------------------------------- */
  if (stats.especes.length) {
    const tab = el('div', 'card');
    tab.append(el('div', 'field-label', 'Espèces relevées'));
    for (const e of stats.especes.slice(0, 30)) {
      const r = el('div', 'admin-row');
      const k = el('span', 'admin-row-k');
      const pastille = el('span', 'corpus-dot');
      pastille.style.background = couleurDe(e.id);
      k.append(pastille, document.createTextNode(e.nom || e.id));
      r.append(k);
      const bouts = [`${nf.format(e.n)}`];
      if (e.tailleMoyCm) bouts.push(`${String(e.tailleMoyCm).replace('.', ',')} cm moy.`);
      if (e.relachees) bouts.push(`${e.relachees} relâchée${e.relachees > 1 ? 's' : ''}`);
      r.append(el('span', 'admin-row-v', bouts.join(' · ')));
      tab.append(r);
    }
    body.append(tab);
  }

  /* --- L'export -------------------------------------------------------- */
  const exp = el('div', 'card');
  exp.append(el('div', 'field-label', 'Export pour l’entraînement'));
  exp.append(el('p', 'tiny',
    'Toutes les prises avec leur relevé de conditions — marée, coefficient, vent, '
    + 'fond, phase lumineuse. Sans adresse : chaque ligne porte l’identifiant de '
    + 'compte, ce qui suffit à regrouper les observations d’un même pêcheur.'));
  const btnExp = button('Télécharger le corpus (JSON)', 'btn-primary', () => exporter(btnExp));
  exp.append(btnExp);
  body.append(exp);

  /* --- Le moteur de la carte ------------------------------------------- */
  let map = null;
  let couche = null;

  async function recharger() {
    bandeau.textContent = 'Chargement…';
    const p = new URLSearchParams({ kind: etat.kind, limit: '5000' });
    if (etat.species && etat.kind === 'catches') p.set('species', etat.species);
    if (etat.user) p.set('user', etat.user);
    if (etat.jours) p.set('from', String(Date.now() - etat.jours * 86400000));

    let rep;
    try {
      rep = await sync.apiCall(`/api/admin/corpus/points?${p}`);
    } catch (e) {
      bandeau.textContent = `Échec du chargement : ${e?.message || 'erreur'}`;
      return;
    }
    await dessiner(rep);
  }

  async function dessiner(rep) {
    const pts = rep.points || [];
    bandeau.textContent = rep.tronque
      ? `${nf.format(pts.length)} points affichés — TRONQUÉ au plafond de ${nf.format(rep.limite)}. `
        + 'Réduisez la période ou filtrez pour tout voir.'
      : `${nf.format(pts.length)} point${pts.length > 1 ? 's' : ''}.`;
    bandeau.className = rep.tronque ? 'tiny c-red' : 'tiny';

    /* Leaflet est chargé À LA DEMANDE, pas au démarrage de l'app. Se contenter
     * de tester `window.L` affichait « indisponible hors ligne » sur une
     * machine parfaitement en ligne : la bibliothèque n'était pas absente,
     * elle n'avait simplement jamais été demandée depuis cet écran. */
    let L;
    try {
      L = await loadLeaflet();
    } catch {
      bandeau.textContent = 'Carte indisponible : Leaflet n’a pas pu être chargé.';
      return;
    }

    if (!map) {
      map = L.map(holder, { zoomControl: false, preferCanvas: true, attributionControl: true })
        .setView([49.93, 1.08], 10);
      /* En haut à gauche : en bas à droite, les commandes se posaient sur le
       * foyer de points le plus dense — vérifié en photographiant l'écran, la
       * grappe de Dieppe passait derrière les boutons. Le coin haut gauche est
       * le seul libre : le bas droit porte l'attribution, le haut droit la
       * croix de fermeture de la feuille. */
      L.control.zoom({ position: 'topleft' }).addTo(map);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '© OpenStreetMap',
      }).addTo(map);
      /* La feuille s'ouvre avec la carte encore invisible : Leaflet mesure
       * alors un conteneur de taille nulle et n'affiche qu'une tuile grise.
       * `invalidateSize` après le rendu est le seul remède. */
      setTimeout(() => map.invalidateSize(), 60);
    }

    if (couche) couche.remove();
    couche = L.layerGroup().addTo(map);

    for (const pt of pts) {
      const c = etat.kind === 'catches' ? couleurDe(pt.sp) : '#4dabf7';
      const m = L.circleMarker([pt.lat, pt.lon], {
        radius: 5, weight: 1, color: '#00000055', fillColor: c, fillOpacity: 0.85,
      });
      m.bindPopup(bulle(pt, nomDe, etat.kind));
      couche.addLayer(m);
    }

    if (pts.length) {
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.15), { maxZoom: 13 });
    }
    peindreLegende();
  }

  function peindreLegende() {
    clear(legende);
    if (etat.kind !== 'catches') return;
    for (const e of stats.especes.slice(0, 10)) {
      const item = el('span', 'corpus-legend-item');
      const d = el('span', 'corpus-dot');
      d.style.background = couleurDe(e.id);
      item.append(d, document.createTextNode(e.nom || e.id));
      legende.append(item);
    }
  }

  recharger();
}

/** Le contenu d'une bulle. Du texte simple : jamais de HTML construit à la main. */
function bulle(pt, nomDe, kind) {
  const l = [];
  const quand = pt.t ? new Date(Number(pt.t)).toLocaleString('fr-FR') : null;
  if (kind === 'catches') {
    l.push(pt.spn || pt.sp || 'Prise');
    if (pt.len) l.push(`${pt.len} cm`);
    if (pt.rel === 1 || pt.rel === true) l.push('relâchée');
    if (pt.maree != null) l.push(`marée ${String(pt.maree).replace('.', ',')} m`);
    if (pt.coef != null) l.push(`coef ${pt.coef}`);
    if (pt.vent != null) l.push(`vent ${String(pt.vent).replace('.', ',')} nds`);
    if (pt.fond != null) l.push(`fond ${String(pt.fond).replace('.', ',')} m`);
  } else if (kind === 'soundings') {
    l.push('Sonde');
    if (pt.zero != null) l.push(`${String(pt.zero).replace('.', ',')} m au zéro`);
    else if (pt.brut != null) l.push(`${String(pt.brut).replace('.', ',')} m brut (non corrigée)`);
    if (pt.fiabilite) l.push(`fiabilité ${pt.fiabilite}`);
  } else {
    l.push(pt.nom || 'Marque');
    if (pt.fond != null) l.push(`${pt.fond} m`);
  }
  if (quand) l.push(quand);
  l.push(nomDe.get(pt.uid) || pt.uid);
  return l.join(' · ');
}

/* ==========================================================================
 * L'export
 * --------------------------------------------------------------------------
 * On reboucle sur le curseur jusqu'à ce que le serveur dise qu'il n'y a plus
 * rien. Le plafond de tours est un garde-fou, pas une limite de conception :
 * une boucle de pagination qui ne peut pas s'arrêter est une boucle qui fige
 * l'écran, et il vaut mieux un export incomplet ANNONCÉ qu'un onglet mort.
 * ========================================================================== */
async function exporter(btn) {
  const initial = btn.textContent;
  btn.disabled = true;
  const lignes = [];
  let curseur = null;
  let tours = 0;
  const MAX_TOURS = 200;

  try {
    do {
      btn.textContent = `Téléchargement… ${nf.format(lignes.length)} prises`;
      const p = new URLSearchParams({ limit: '1000' });
      if (curseur) { p.set('afterUser', curseur.user); p.set('afterRec', curseur.rec); }
      const rep = await sync.apiCall(`/api/admin/corpus/export?${p}`);
      for (const l of rep.lignes) {
        /* Le serveur rend `data` en CHAÎNE, telle qu'elle est stockée — il ne
         * l'a pas parsée, c'est tout l'intérêt. On la remet en objet ici, où
         * le CPU ne se compte pas en millisecondes. */
        let d = null;
        try { d = JSON.parse(l.data); } catch { /* ligne abîmée : on la saute */ }
        if (d) lignes.push({ pecheur: l.user, id: l.id, prise: d });
      }
      curseur = rep.suivant;
      tours++;
    } while (curseur && tours < MAX_TOURS);

    if (curseur) {
      toast(`Export arrêté à ${nf.format(lignes.length)} prises (limite de sécurité).`, 'danger', 6000);
    }

    const doc = {
      genere: new Date().toISOString(),
      note: 'Corpus de pêche — sans adresse. « pecheur » est un identifiant de '
        + 'compte tiré au hasard, qui regroupe les observations sans nommer personne.',
      prises: lignes.length,
      lignes,
    };
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grims-corpus-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`${nf.format(lignes.length)} prises exportées.`, 'good');
  } catch (e) {
    toast(`Export impossible : ${e?.message || 'erreur'}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = initial;
  }
}

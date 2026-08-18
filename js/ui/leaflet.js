/* ==========================================================================
 * ui/leaflet.js — chargement de Leaflet, à la demande et une seule fois
 * --------------------------------------------------------------------------
 * Leaflet n'est pas chargé au démarrage : c'est une bibliothèque entière qu'on
 * ne veut pas payer tant que personne n'a ouvert une carte. Il est donc injecté
 * au premier besoin, depuis le dépôt (`vendor/`) et non depuis un CDN — une
 * carte qui exige le réseau au premier lancement ne sert à rien en mer.
 *
 * CE FICHIER EXISTE PARCE QU'IL Y A DEUX APPELANTS.
 *
 * Le chargeur vivait dans `views/map.js`, privé. Quand l'écran d'administration
 * a eu besoin d'une carte à son tour, il a trouvé `window.L` vide et affiché
 * « Carte indisponible hors ligne » — un message faux, sur une machine
 * parfaitement en ligne, pour une bibliothèque qui n'attendait qu'un appel.
 *
 * Recopier le chargeur aurait donné deux endroits à corriger le jour où le
 * chemin de `vendor/` change. Il est donc ici, et les deux écrans l'appellent.
 *
 * La promesse est mémorisée : deux écrans qui s'ouvrent coup sur coup ne
 * doivent pas injecter deux fois la même balise — Leaflet se réinitialiserait
 * et les cartes déjà construites perdraient leurs couches.
 * ========================================================================== */

const CSS = 'vendor/leaflet/leaflet.css';
const JS = 'vendor/leaflet/leaflet.js';

let enCours = null;

/**
 * @returns {Promise<object>} l'objet `L` de Leaflet.
 * @throws si le fichier est introuvable — cache purgé et appareil hors ligne.
 */
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (enCours) return enCours;

  enCours = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS;
    document.head.append(link);

    const s = document.createElement('script');
    s.src = JS;
    s.async = true;
    s.onload = () => resolve(window.L);
    s.onerror = () => {
      /* On oublie l'échec : sans cela, un appareil qui retrouve le réseau
       * garderait à jamais la promesse rejetée et ne réessaierait plus. */
      enCours = null;
      reject(new Error('Leaflet indisponible'));
    };
    document.head.append(s);
  });

  return enCours;
}

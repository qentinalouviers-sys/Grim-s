/* ==========================================================================
 * core/build.js — identité de la version embarquée
 * --------------------------------------------------------------------------
 * Une app hors ligne est servie depuis un cache : rien ne garantit que l'écran
 * qu'on regarde corresponde au dépôt. Sans version affichée, un correctif livré
 * et un correctif reçu sont indiscernables — et on passe son temps à corriger
 * du code que l'utilisateur n'exécute pas.
 *
 * Cette chaîne DOIT être IDENTIQUE à celle de sw.js — c'est elle qui décide du
 * renouvellement des caches.
 *
 * Elle a divergé : sw.js est passé en v1.40.0 pendant que ce fichier restait
 * en v1.36.0, et l'app annonçait donc une version vieille de quatre livraisons
 * alors qu'elle exécutait la nouvelle. Une règle tenue par un commentaire est
 * une règle qui se casse ; `scripts/selftest.py` la vérifie désormais, et
 * l'intégration continue refuse une livraison où les deux ne concordent pas.
 * ========================================================================== */

export const APP_VERSION = 'v1.41.0';

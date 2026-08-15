/* ==========================================================================
 * core/build.js — identité de la version embarquée
 * --------------------------------------------------------------------------
 * Une app hors ligne est servie depuis un cache : rien ne garantit que l'écran
 * qu'on regarde corresponde au dépôt. Sans version affichée, un correctif livré
 * et un correctif reçu sont indiscernables — et on passe son temps à corriger
 * du code que l'utilisateur n'exécute pas.
 *
 * Cette chaîne DOIT suivre celle de sw.js : c'est elle qui décide du
 * renouvellement des caches.
 * ========================================================================== */

export const APP_VERSION = 'v1.12.0';

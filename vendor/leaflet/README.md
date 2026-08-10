# Leaflet 1.9.4 — embarqué

Copie de `leaflet@1.9.4` (npm), fichiers `dist/` uniquement.

## Pourquoi embarqué et pas en CDN

Le CDN condamnait le mode CARTE au premier lancement hors ligne : tant que le
moteur n'avait pas été téléchargé une fois, l'écran affichait « carte
indisponible ». Pour une app dont la règle est « le réseau est une option,
jamais une dépendance », c'était le seul écran qui trahissait le principe.

42 ko gzippés, et la carte fonctionne dès la première ouverture, avion activé.

Licence BSD 2-Clause, voir LICENSE. Mise à jour : remplacer les fichiers par
ceux d'une nouvelle version et vérifier `vendor/leaflet/leaflet.js` dans sw.js.

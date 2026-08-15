# Grim's Compagnon

Copilote de navigation et de pêche en mer pour le secteur de **Dieppe**.
Application web mobile, installable, **qui fonctionne sans réseau**.

Vanilla JS, modules ES natifs. Zéro dépendance, zéro build step, zéro compte,
zéro serveur. Les données restent sur le téléphone.

---

## Le principe

En mer, on perd le réseau. C'est la contrainte qui a dicté toute
l'architecture : **le réseau est une option, jamais une dépendance.**

| Donnée | Hors ligne ? | Comment |
|---|---|---|
| Marée, coefficient, PM/BM | ✅ toujours | PM/BM officielles SHOM sur 7 j, modèle harmonique 23 constituants au-delà |
| Courant de marée, dérive | ✅ toujours | dérivé de la marée + calibration GPS du bateau |
| Soleil, lune, crépuscules | ✅ toujours | éphémérides calculées à bord |
| Scoring pêche, plan de sortie | ✅ toujours | moteur local, aucun appel distant |
| Position, cap, état de la mer | ✅ toujours | capteurs du téléphone |
| Carte | ✅ moteur toujours, tuiles si préchargées | Leaflet embarqué dans le dépôt, tuiles en IndexedDB (bouton « ⤓ ») |
| Vent, houle, pression, T° eau | ⚠️ dernière valeur connue | Open-Meteo, avec l'âge affiché |

Une seule donnée se dégrade hors ligne, et l'app dit toujours de quand elle
date. Elle ne fait jamais semblant.

---

## Les modes

Accessibles en un geste par la barre du bas — pensée pour le pouce, à une main,
sur un bateau qui bouge. Le premier onglet devient **PILOTE** dès qu'une route
est armée : un écran qui ne sert qu'en traversée n'a pas à voler de la place au
reste le temps qu'on est au mouillage.

### 🧭 NAV
Vitesse fond et vent en jauges, compas demi-cercle à ligne de foi fixe (le
cadran tourne, comme un compas de route), bandeau température d'eau / pression
/ mer / lune / soleil, courbe de marée 24 h, rose de courant et profil flot-
jusant sur la journée, conseil du guide en une ligne.

Actions : veille de mouillage avec alarme de dérapage, enregistrement de
sortie, retour au port, relevé de dérive. Deux boutons vivent en permanence
dans la barre d'état :

- **MOB** — un seul appui, sans confirmation : position figée, alarme, et
  relèvement porté sur le compas et la carte.
- **SOS** — l'écran de détresse. Il **ne déclenche pas** le SOS natif du
  téléphone : aucune page web ne le peut, ces fonctions sont câblées sur les
  boutons physiques et exposées à aucune API. L'écran le dit et rappelle la
  combinaison de touches. Ce qu'il fait à la place est plus utile en mer, parce
  qu'en détresse le temps ne se perd pas à composer un numéro mais à **dire où
  l'on est** : la position en degrés-minutes décimales occupe le haut de
  l'écran, en gros, dans la seule forme qui se lit à voix haute sans erreur.
  Dessous, les trois canaux — **VHF 16** avec le message MAYDAY pré-rédigé
  (nom du bateau et personnes à bord mémorisés une fois pour toutes), le
  **196** qui tombe directement sur le CROSS là où le 112 passe par les secours
  terrestres, et un SMS ou un partage avec la position dedans pour prévenir à
  terre. Rien de tout ça n'a besoin de données : les numéros passent par le
  réseau téléphonique, le message est calculé à bord.

### 🎯 PILOTE — navigation GPS

Armé depuis n'importe où : bouton **🎯 Naviguer vers…** du mode NAV, bouton 🎯
de la carte, appui long sur la carte, fiche d'une marque, fiche d'une prise, ou
fiche d'une bouée du mode HORIZON.

**Choisir un but**, quatre entrées :

- **Chiffres** — pavé numérique, en degrés-minutes décimales, une case par
  grandeur et un bouton N/S · E/O. On ne tape pas de symbole `°` avec des
  doigts mouillés. Un champ de collage accepte aussi n'importe quelle écriture
  reçue par message (décimal, DDM, DMS, ordre inversé) et remplit les cases.
- **Marques** — le carnet personnel, trié par distance.
- **Prises** — là où ça a mordu, avec l'espèce et la date. Y retourner est la
  première chose qu'on veut faire à la sortie suivante.
- **Repères** — port d'attache, MOB, mouillage, dernier waypoint.

**Ce que le mode pilotage calcule**, et qui le distingue d'une flèche « tout
droit » :

- **Cap à tenir** — le triangle des vitesses est résolu à chaque fix. Le bateau
  avance dans une eau qui bouge : mettre l'étrave sur le relèvement du but fait
  décrire une banane à la route fond et finit par un dernier mille à remonter
  le courant. On calcule l'angle de correction `sin α = − dérive·sin θ / V` et
  on affiche le cap corrigé. Sur la carte, la route voulue (vert) et le cap à
  tenir (cyan) sont deux traits distincts : l'écart entre eux *est* la
  correction, et ça se comprend sans lire un chiffre.
- **Route intenable** — si la composante travers de la dérive dépasse la
  vitesse du bateau, aucun cap ne tient la route. C'est dit, au lieu d'afficher
  un cap impossible.
- **Ordre de barre** — « 12° à droite », pas un écart à interpréter.
- **Écart de route (CDI)** — l'instrument de contrôle, à échelle adaptative
  (±30 m près du but, ±300 m en route), à la convention des instruments de
  bord : on barre vers l'aiguille.
- **Heure d'arrivée** — sur la VMG mesurée quand le bateau bouge, sur la
  vitesse fond *prévue par le triangle* sinon. Une ETA existe donc avant même
  d'avoir quitté le corps-mort.
- **Ce qu'on trouvera sur le point** — hauteur d'eau et courant à l'heure
  d'arrivée, pas à l'heure du départ. Avertissement si l'arrivée tombe après le
  coucher du soleil.

**L'arrivée** en trois temps : à 200 m l'app passe en approche (« réduis, prends
la veille visuelle »), au rayon d'arrivée (10 m par défaut) elle vibre, sonne,
affiche un panneau franc — et la carte **dézoome** sur la zone en coupant le
suivi automatique, parce que la question change : on ne demande plus « où
vais-je » mais « qu'est-ce qu'il y a autour de moi ». L'arrivée se déclenche
aussi au **passage du travers** du point : avec de la mer, on peut passer à 12 m
du but sans jamais entrer dans un cercle de 10 m.

### 🔦 HORIZON — veille visuelle et identification des feux

Le mode qui répond à la question qu'on se pose vraiment de nuit, et qu'aucune
app grand public ne traite : **c'est quoi, ce feu, là-bas ?**

Les données viennent d'**OpenStreetMap via l'API Overpass** — libre, gratuite,
sans clé. La même source que la surcouche OpenSeaMap de la carte, sauf qu'ici on
ne récupère pas des *images* de bouées : on récupère les bouées, avec leur nom,
leur catégorie, la couleur de leur feu, son rythme, sa période, sa portée
nominale et sa hauteur. Une requête couvre 30 km et se garde un mois : on
télécharge au port, on s'en sert au large.

- **Bandeau d'horizon** — le champ visuel réel autour du cap (±65°), avec les
  marques posées à leur relèvement et dessinées comme sur la carte : bandes de
  couleur, voyant AISM (les deux cônes d'une cardinale, le cylindre d'une
  latérale bâbord), point lumineux à la couleur du feu. On lève les yeux, on
  baisse les yeux, c'est au même endroit.
- **Portée réelle** — un feu de 12 milles à 9 mètres de haut ne se voit pas à
  12 milles depuis un cockpit à 2 mètres : il se voit à 8,9. On croise portée
  nominale, **portée géographique** `D = 2,03 (√h_œil + √h_feu)` et visibilité
  météo, et on dit **lequel des trois limite**. La hauteur d'œil est réglable.
- **Identificateur** — on décrit ce qu'on voit : couleur, rythme, relèvement
  pointé au compas, et surtout la **période, mesurée en tapant l'écran en
  cadence avec les éclats**. Compter « vingt-et-un, vingt-deux » sur un pont qui
  bouge est le meilleur moyen de se tromper d'une seconde ; la médiane de quatre
  intervalles, non. Les candidats sont classés avec **le détail de ce qui
  concorde** — un verdict qu'on ne peut pas discuter n'est pas utilisable pour
  une décision de nuit.

Chaque marque est un but de navigation en un tap, ou devient un repère du
carnet. Donnée contributive : à confirmer sur la carte officielle, et l'écran le
dit.

### 🗺️ CARTE
OpenStreetMap + **balisage maritime OpenSeaMap**, tuiles mises en cache
localement et préchargeables par zone.

Leaflet est **embarqué dans le dépôt** (`vendor/leaflet/`, 42 ko gzippés), pas
chargé depuis un CDN. C'était le dernier écran qui trahissait la règle « le
réseau est une option » : tant que le moteur n'avait pas été téléchargé une
fois, le mode CARTE affichait « indisponible hors ligne ». Il s'ouvre
maintenant dès la première fois, en mode avion.

La **dérive prédictive**, dans les deux sens :

- **Dérive prévue** — « si je coupe le moteur ici, je passe où dans 40 min ? »
- **Point de largage** — « je veux dériver SUR ce point à 07 h 30, où est-ce
  que je me mets à l'eau ? » C'est le vrai geste de pêche, et il est calculé
  par intégration inverse de la trajectoire.

Le tracé est encadré d'un **cône d'incertitude** qui s'élargit avec le temps.
Un modèle de courant affiché comme un trait fin est un mensonge graphique.

Aussi : champ de vecteurs de courant, import/export GPX, waypoints, cercle de
mouillage, et la **route active** avec son cercle d'arrivée.

Les **marques personnelles** ont un titre et une description libre, éditables
après coup (un repère qu'on ne peut plus renommer se fige sur le nom donné à la
va-vite, et six mois plus tard « Marque 12/04 » ne dit plus rien). Elles se
créent par appui long sur la carte, depuis la position courante, depuis une
prise, depuis une bouée du mode HORIZON, ou depuis un point saisi au clavier.

### 🎣 ENREGISTRER UNE PRISE — en un geste

Bouton flottant, présent sur NAV, CARTE et PÊCHE. **Un tap ouvre la grille
d'espèces, un deuxième tap enregistre.** C'est tout. Un appui long sur le
bouton rejoue directement la dernière espèce — le banc de maquereaux ne laisse
pas le temps de choisir dix fois.

Les espèces hors des sept suivies se saisissent au clavier une seule fois :
elles rejoignent ensuite la grille et se notent à un tap comme les autres.

Le reste est capturé **automatiquement**, sans rien demander :

| | |
|---|---|
| Position | latitude, longitude, précision GPS, poste le plus proche et son relèvement |
| Marée | hauteur, coefficient, sens, temps avant/après PM et BM, étale de courant, hauteur d'eau sur le poste |
| Courant | courant de marée, dérive réelle du bateau, direction de chacun, état de calibration |
| Météo & mer | vent et rafales, pression et tendance 6 h, température de l'eau, houle, visibilité, clarté estimée |
| Ressenti bord | état de mer mesuré à l'accéléromètre — la mer sous la coque, pas celle d'une maille de 8 km |
| Lumière | phase, hauteur du soleil, minutes depuis le lever ou le coucher, lune |
| Modèle | le score que l'app prédisait à cet instant, avec le facteur porteur et le facteur limitant |
| Traçabilité | provenance de la marée (SHOM / harmonique / provisoire) et âge de la météo |

Ce dernier point est ce qui transforme un carnet en boucle d'apprentissage :
sans le score prédit au moment de la prise, on ne peut jamais savoir si le
modèle avait raison. Et sans la provenance de la marée, on ne sait pas ce que
vaut la prise trois mois plus tard.

Chaque prise apparaît **sur la carte**, marqueur coloré par espèce, taille
proportionnelle au nombre, contour pointillé si relâchée, prises du jour en
avant. Un clic ouvre le contexte complet ; on peut router dessus, relancer une
dérive vers le point, ou en faire une marque permanente. L'export GPX les
emporte avec leur contexte en description, lisible dans OpenCPN ou Navionics.

Une prise s'écrivant en un tap, elle s'annule en un tap : la confirmation
porte un bouton **Annuler**.

### 🐟 PÊCHE
Trois niveaux de lecture, dans l'ordre des questions qu'on se pose :

1. **Le plan** — quoi faire maintenant et dans deux heures : espèce, créneau,
   poste, technique, ce qui porte, ce qui freine, ce que dit la loi.
2. **La grille** espèces × heures, colorée en continu.
3. **Le détail** — fenêtres, barres de facteurs, postes classés, leurres,
   réglementation complète.

Sept espèces de la Manche orientale : bar, lieu jaune, turbot/barbue,
saint-pierre, raie bouclée, dorade grise, maquereau.

### 📓 JOURNAL
Prises avec leur contexte complet, marques, et surtout **ce que le modèle a
appris** — avec les chiffres. Calibration du modèle de dérive, export/import
des données, sources et limites.

---

## Ce qui distingue ce projet

### 1. La marée est calculée, pas téléchargée

L'approche courante — « on télécharge la courbe SHOM tous les jours » — a deux
défauts rédhibitoires : elle ne marche que si on a du réseau avant de partir,
et elle plafonne à sept jours d'horizon. Or on planifie une sortie trois
semaines à l'avance, et on part parfois sans avoir rouvert l'app depuis quinze
jours.

Ici la marée est un **modèle harmonique embarqué** :

```
h(t) = Z₀ + Σ f_i(t) · A_i · cos( V_i(t) + u_i(t) − g_i )
```

23 constituants, corrections nodales de Schureman incluses. Horizon illimité,
zéro octet de réseau, quelques millisecondes pour 24 h de courbe.

**Et les constantes s'ajustent toutes seules.** `scripts/refresh_tide.py`
récupère la donnée SHOM et l'accumule dans une archive glissante ;
`scripts/fit_harmonics.py` réajuste le modèle dessus par moindres carrés
régularisés. Le workflow tourne deux fois par jour.

Ce que publie réellement le SHOM, mesuré et non supposé : la vignette donne les
**pleines et basses mers**, avec leurs heures et leurs coefficients — pas de
courbe échantillonnée. Soit environ quatre points par jour. Ce sont malgré tout
les points les plus informatifs d'une marée, puisqu'ils en portent l'amplitude
et la phase, et ils alimentent l'archive à leur horodatage exact.

Cette parcimonie a une conséquence qu'il faut énoncer : avec quatre points par
jour on ne peut pas ajuster les harmoniques d'eaux peu profondes — M4, M6, MS4
ont des périodes de 4 à 6 heures, elles sont repliées par un échantillonnage à
6 heures. Le fitter les maintient donc à leurs valeurs publiées, et seules les
composantes astronomiques sont pilotées par les données. Erreur d'extrapolation
mesurée sur série synthétique, 45 jours au-delà de la fenêtre d'ajustement :

| Archive | Constituants pilotés | Erreur moyenne |
|---|---|---|
| aucune (constantes de départ) | 0 | ~16 cm |
| 7 jours | 3 | ~14 cm |
| 20 jours | 6 | ~11 cm |
| 1 an | 16 | ~8 cm |

Le plancher vers 8 cm vient précisément des harmoniques non ajustables. Il
tomberait à moins d'un centimètre si une courbe échantillonnée devenait
disponible — le fitter libère automatiquement les constituants dès que le pas
d'échantillonnage le permet, aucune modification ne serait nécessaire.

**Pour l'usage courant, ça n'est pas la limite qui compte** : sur les sept jours
publiés par le SHOM, l'app utilise directement ses heures de PM/BM et ses
coefficients officiels, et le modèle ne sert qu'à donner la hauteur entre deux
extrema. Le modèle harmonique est la source au-delà de sept jours — planifier
une sortie dans trois semaines, ou rouvrir l'app après quinze jours sans réseau.

Tant que l'archive n'atteint pas 20 jours — durée en dessous de laquelle M2 et
S2 ne se séparent pas — le modèle reste marqué **provisoire** dans l'interface.

### 2. Le courant a une direction, et une incertitude

Le courant de marée n'est pas téléchargeable en côtier : Copernicus et
Open-Meteo tournent à ~8 km de maille, là où le courant réel atteint 3 nœuds
quand leur résiduelle en donne 0,2.

Le modèle local écrit directement :

```
vitesse (nœuds) = k · |dh/dt| · facteurLocal(position)
```

avec `dh/dt` **brut** — il porte déjà l'amplitude vive-eau / morte-eau. (Le
normaliser sur la fenêtre *puis* multiplier par un rapport de coefficient, comme
on le voit souvent, applique deux fois la même correction et surestime les
vives-eaux d'environ 40 %.)

La direction vient de l'axe flot/jusant du secteur, qui tourne progressivement
autour de l'étale — un renverse réel prend une vingtaine de minutes.

Trois paramètres sont incertains : `k`, l'axe, et le déphasage entre l'étale de
hauteur et l'étale de courant. **Les trois s'ajustent sur les relevés GPS de
l'utilisateur** (`⏱ Relever`, moteur coupé). Moindres carrés fermé pour
l'échelle, moyenne circulaire pour les axes, balayage pour le déphasage — après
une vingtaine de relevés, le modèle n'est plus générique : il est celui de ce
bateau sur ces spots.

### 3. Le score dit pourquoi

```
score = clamp01( Σ(poids × facteur) / Σ(poids) ) × poidsSaisonnier × 100
```

Deux décisions de conception :

- La **saison multiplie** au lieu de se moyenner. Sinon un maquereau en janvier
  remonte à 55/100 parce que le vent est bon. Là il tombe à 4.
- Un facteur sans donnée est **retiré** de la moyenne au lieu de compter zéro.
  Pas de température d'eau → le score reste juste, il est seulement moins
  informé, et l'app affiche son taux de couverture.

Le **facteur limitant** — `argmax (1 − valeur) × poids` — est ce qui rend le
score actionnable : l'app dit s'il faut décaler de deux heures, changer de
poste ou rentrer.

### 4. Le vent contre le courant

Vingt nœuds dans le sens du courant, c'est roulant. Vingt nœuds contre 2,5
nœuds de jusant, c'est une mer courte et cassante à 1,5 m. Aucun modèle de
houle global ne le voit — la maille est trop grosse. Ici c'est calculé, et
c'est une alerte.

### 5. Le téléphone comme houlographe

L'accéléromètre, intégré deux fois, mesure le pilonnement réel sous la coque.
Le modèle donne la houle d'une maille de 8 km ; ça, c'est la mer sous le bateau,
maintenant. Affiché comme « ressenti bord », jamais comme une hauteur
significative certifiée.

### 6. L'app rend des comptes

Source de marée affichée en permanence (SHOM / harmonique / provisoire), âge de
la météo, état de calibration du modèle de dérive, taux de couverture des
scores, nombre de prises ayant servi à l'apprentissage, écart RMS du modèle.
Un outil de mer qui cache son incertitude fabrique de la fausse confiance.

---

## Et l'IA ?

L'intelligence est **embarquée et déterministe** — un système expert qui
transforme les valeurs calculées en décisions formulées. C'est un choix, pas un
renoncement :

1. Ça doit marcher **sans réseau**, or c'est justement quand on ne capte plus
   qu'on a besoin d'un conseil.
2. Ça doit être **gratuit et sans inscription**, la contrainte posée.
3. Un modèle de langage **inventerait** des heures de marée plausibles. Ici
   chaque phrase est adossée à une valeur calculée et traçable.

S'y ajoute un **apprentissage local réel** (`js/fishing/learning.js`) : biais
d'abondance par espèce, poids saisonniers réajustés, calibration du modèle de
dérive, productivité par poste. Seuils volontairement prudents (8, 20 et 5
observations) et mélange progressif : avec trois captures on ne surajuste pas.

La frontière pour une v2 est nette : brancher un LLM ne remplacerait que la
fonction `narrate()` de `advisor.js`, à partir des mêmes faits structurés. Le
raisonnement, lui, resterait local.

---

## Structure

```
index.html                  coque SPA
manifest.webmanifest        PWA
sw.js                       service worker — coque, données, Leaflet
css/app.css                 thème sombre maritime + mode nuit rouge
vendor/
  leaflet/    Leaflet 1.9.4, embarqué (BSD-2-Clause) — pas de CDN
js/
  core/       geo, formatage marin, store réactif, IndexedDB, réseau tolérant
  data/       astro, harmoniques, marée, météo, courant & dérive, balisage
  sensors/    GPS, compas, centrale inertielle
  fishing/    courbes, espèces & réglementation, moteur, postes, guide,
              enregistrement des prises, apprentissage
  nav/        moteur de navigation : cap à tenir, écart de route, arrivée
  ui/         fabrique DOM, instruments canvas, sélecteur de destination
  views/      nav, pilot, map, horizon, fish, log
data/
  harmonics-dieppe.json     constantes de marée (ajustées automatiquement)
  zones-dieppe.json         secteurs types et nœuds de courant
  tide-dieppe.json          fenêtre SHOM courante (généré)
  tide-history.json         archive glissante pour l'ajustement (généré)
scripts/
  tidal.py                  arguments astronomiques — miroir de js/data/harmonics.js
  refresh_tide.py           récupération SHOM + archive
  fit_harmonics.py          ajustement par moindres carrés régularisés
  selftest.py               contrôles de cohérence, dont JS ↔ Python
```

### Une invariante à ne pas casser

`scripts/tidal.py` et `js/data/harmonics.js` doivent produire **exactement** la
même hauteur. C'est ce qui rend l'ajustement auto-cohérent : les phases écrites
par le fitter sont relues par le moteur dans la même convention.

`scripts/selftest.py` exécute les deux moteurs sur les mêmes instants et
compare — écart constaté : 6 × 10⁻¹⁵ m. Toute divergence fait échouer la CI.

Le même fichier vérifie aussi la navigation, pour la même raison : une erreur y
serait **invisible à l'écran**. Un point mal lu reste un point plausible, et un
cap à tenir faux de dix degrés ressemble à un cap à tenir. Le contrôle recompose
donc le triangle des vitesses — cap calculé + dérive doit redonner *exactement*
la route fond demandée — et relit une même position écrite de cinq façons
différentes.

---

## Déploiement

GitHub Pages, automatique.

1. **Settings → Pages → Source : GitHub Actions**
2. Pousser sur la branche. `deploy.yml` vérifie (syntaxe JS, syntaxe Python,
   cohérence des données) puis publie.
3. `refresh-tide.yml` récupère le SHOM et réajuste le modèle, deux fois par
   jour. Les deux étapes réseau sont `continue-on-error` : si le SHOM change son
   format, l'app continue de tourner sur son modèle embarqué.

### En local

```bash
python3 -m http.server 8080     # les modules ES exigent http://, pas file://
python3 scripts/selftest.py     # contrôles de cohérence
```

### Sur iPhone

Safari → Partager → **Sur l'écran d'accueil**. Indispensable : c'est le seul
mode où iOS accorde le plein écran, le maintien d'écran allumé et une
persistance durable d'IndexedDB.

---

## Capteurs et permissions

| Capteur | API | Particularité |
|---|---|---|
| Position | Geolocation | `getCurrentPosition` d'abord — sinon iOS reste muet 30 s |
| Compas | DeviceOrientation | `requestPermission()` sur Safari ; **absent sur Chrome iOS** → repli route fond |
| Mer | DeviceMotion | `requestPermission()` sur iOS 13+ |
| Écran allumé | Wake Lock | réacquis à chaque retour au premier plan |

Le compas est en **contrôle croisé permanent** avec la route fond GPS : un écart
stable et significatif est une déviation magnétique du bord, et l'app l'affiche
au lieu de la subir.

---

## Limites — à lire

- **Ce n'est pas un instrument de navigation homologué.** Aide à la décision.
  Ne remplace ni les cartes officielles, ni les bulletins météo marine, ni le
  jugement du chef de bord.
- Les **secteurs livrés** (`data/zones-dieppe.json`) sont des **archétypes
  d'habitat positionnés approximativement**, pas des marques relevées au GPS.
  Ils portent le raisonnement de zone, pas des coordonnées de pêche. Ils sont
  affichés en pointillés avec la mention « à recaler ». Le vrai carnet est
  celui que construit l'utilisateur.
- Le **modèle de courant** n'est pas hydrodynamique. C'est un modèle de premier
  ordre calibrable, avec son incertitude affichée.
- Les **poids du scoring** viennent de la littérature halieutique Manche. Ce
  sont des opinions bien rangées, pas un modèle validé — d'où le journal de
  captures qui les réajuste.
- La **réglementation** est datée (`lastCheckedISO`) et périmera. À revérifier
  chaque année auprès de la **DIRM Manche Est – Mer du Nord**.
- Le **balisage du mode HORIZON** vient d'OpenStreetMap : contributif, donc
  parfois incomplet ou périmé. Une identification proposée est une **hypothèse à
  confirmer à la carte**, jamais un verdict. Et le cap à tenir du mode PILOTE
  vaut ce que vaut le modèle de courant qui le nourrit : il ne dispense ni de la
  veille visuelle, ni de vérifier que la route ne passe pas sur un danger — le
  moteur trace une droite, il ne connaît pas les hauts-fonds.

---

## Sources

Toutes gratuites, sans clé ni inscription.

- **SHOM** — vignette de marée officielle de Dieppe (pleines et basses mers, heures légales, coefficients)
- **Open-Meteo Forecast** — vent, rafales, pression, visibilité, nébulosité
- **Open-Meteo Marine** — houle, mer du vent, température de surface, courant résiduel
- **OpenStreetMap** — fond de carte (moteur Leaflet embarqué, BSD-2-Clause)
- **OpenSeaMap** — balisage maritime (tuiles)
- **OpenStreetMap via Overpass API** — attributs du balisage : catégorie, voyant,
  couleur, rythme et portée des feux (mode HORIZON)
- Soleil et lune : calculés localement (NOAA / série lunaire tronquée)

## Vie privée

Aucun compte, aucun serveur applicatif, aucune télémétrie, aucun traceur.
Positions, marques et captures ne quittent jamais l'appareil. Export manuel en
JSON ou GPX à la demande.

# La sonde — comment obtenir `data/bathy-dieppe.json`

Ce fichier **n'est pas dans le dépôt**, et c'est délibéré : il se fabrique à
partir d'un modèle numérique de terrain public qui pèse une centaine de
mégaoctets et se télécharge une fois. Tout le reste est prêt — le décodeur
embarqué, le moteur qui s'en sert, la couche carte.

Sans lui, l'app fonctionne à l'identique : elle est seulement moins renseignée
sur les fonds, et le carnet de sondes (relevés au sondeur du bord) prend le
relais là où l'on est passé.

---

## En deux commandes

```bash
# 1. Télécharger le MNT (une fois, ~100 Mo)  → voir « Où prendre le fichier »
# 2. Le réduire à la grille embarquée :
python3 scripts/reduce_mnt.py ~/Téléchargements/MNT_ATL100m_HOMONIM_WGS84.asc
```

Le script n'a besoin d'**aucune dépendance** — ni GDAL, ni numpy. Il produit
`data/bathy-dieppe.json`, environ 130 ko, et refuse tout fichier qui ne
ressemble pas à un modèle de terrain (voir « Garde-fous »).

Pense ensuite à ajouter `data/bathy-dieppe.json` à la liste `SHELL` de `sw.js`
pour qu'il soit disponible hors ligne, et à monter la version.

---

## Où prendre le fichier

### Recommandé — SHOM, MNT de façade Atlantique (projet HOMONIM)

<https://diffusion.shom.fr/mnt-facade-atl-homonim.html>

- Pas de **0,001°**, soit environ **111 m**
- Couvre la mer du Nord, la Manche et le golfe de Gascogne
- Formats `asc`, `glz`, `bag`, `grd` — **prendre `.asc`**, c'est du texte brut
  et le script le lit sans aucune bibliothèque
- Licence ouverte, téléchargement libre
- Source officielle française

### Équivalent — EMODnet Bathymetry

<https://portal.emodnet-bathymetry.eu/>

- 1/16 de minute d'arc, soit environ **115 m**
- Tuiles du DTM en NetCDF ou GeoTIFF
- Le script lit le **GeoTIFF non compressé**, pas le NetCDF

⚠ **Passer par le portail de téléchargement, jamais par le WMS/WCS.** Le service
`ows.emodnet-bathymetry.eu/wcs` répond, découpe et livre un GeoTIFF
parfaitement formé — **sur une bande de huit bits**. Ce sont des index de
palette de 0 à 255, pas des mètres. Un premier passage l'a pris pour argent
comptant : le fichier annonçait des sondes jusqu'à 253 m avec un mode vers
120 m. Personne n'aurait tiqué sans connaître le coin — 120 m, c'est l'altitude
du plateau de Caux, lue comme une profondeur.

---

## Ce que cette donnée permet, et ce qu'elle ne permet pas

À cent mètres de maille, on lit :

- le plateau côtier et sa **cassure**
- les **fosses**, dont celle du chenal
- les **grands bancs** du large, comme structures

On ne lit **pas** le ridin isolé — deux à trois mètres de haut, quelques
centaines de mètres de longueur d'onde. Il passe entre les mailles. Le fichier
produit porte cette limite dans ses métadonnées et l'app l'affiche.

**Pour le ridin, il n'y a que le sondeur du bord.** L'app a un carnet pour ça
(`js/fishing/soundings.js`) : chaque sonde notée est ramenée au zéro des cartes
avec la marée du moment, donc comparable d'une sortie à l'autre, et elle
**prime sur le modèle public** partout où elle existe.

### Et la haute résolution ?

Le SHOM diffuse **Litto3D®** — partie maritime Normandie & Hauts-de-France
2016-2018, du Mont-Saint-Michel à la frontière belge, en licence ouverte, par
dalles de 1 × 1 km. Résolution métrique, acquise au lidar bathymétrique.

Deux réserves, et elles sont sérieuses :

1. le lidar ne pénètre que ce que la turbidité laisse passer. En Manche
   orientale, la couverture utile s'arrête bien avant les 30 m annoncés ;
2. le volume. À l'échelle du mètre, le secteur de Dieppe représente plusieurs
   gigaoctets — hors de question de l'embarquer dans une app hors ligne. Il
   faudrait sélectionner quelques zones et les réduire, ce qui est un travail
   distinct.

C'est une piste réelle pour les postes proches du bord, pas une solution
générale.

---

## Garde-fous du script

Trois refus, tous vérifiés sur des fichiers fabriqués exprès :

| Cas | Comportement |
|---|---|
| Bande de 8 bits | Refusé — « c'est un rendu colorié, pas un modèle de terrain » |
| Profondeurs déjà positives | Détecté au signe dominant, inversé, et annoncé |
| Coin nord-ouest hors de 5–90 m | Refusé — il est à 30 milles au large de Fécamp |

Le dernier a déjà servi. Mieux vaut pas de carte qu'une carte fausse : sur
l'eau, une sonde erronée ne se rattrape pas.

---

## Format produit

Miroir exact de `decode()` dans `js/data/bathy.js` — c'est le décodeur qui fait
foi, le producteur s'y plie :

```json
{
  "size": [233, 500],
  "grid": [d, n, d, n, …],
  "bbox": [sud, ouest, nord, est],
  "step": [dLat, dLon],
  "resolutionM": 334,
  "depthRangeM": [min, max],
  "source": "…", "licence": "…", "fetchedAt": "…"
}
```

`grid` est une liste **plate** de couples (différence, répétitions). Ce n'est
pas un RLE sur les valeurs mais **sur les différences** : le décodeur applique
`prev += d` à chaque répétition, donc une pente régulière se code `[d, n]` et
un plat `[0, n]`. Les sentinelles `32767` (terre) et `32766` (pas de donnée)
échappent à la chaîne et ne décalent pas la valeur suivante.

La ligne 0 de la grille est **le sud**, pas le nord — c'est la convention du
décodeur (`i = (lat − south) / dLat`), et les fichiers ASCII vont du nord au
sud, donc le script inverse.

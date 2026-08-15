#!/usr/bin/env python3
"""
fetch_seabed.py — nature des fonds du secteur de Dieppe, depuis EMODnet.

Produit : data/seabed-dieppe.json

── POURQUOI CETTE DONNÉE ────────────────────────────────────────────────────
À l'échelle où l'on pêche — 20 à 40 m d'eau, quelques milles de côte — ce qui
décide de la présence des espèces n'est ni la chlorophylle ni la température :
c'est le FOND. Le turbot est sur le sable et le ridin, la dorade grise sur
l'épave et la roche, la sole sur la vase. C'est la seule couche de donnée
environnementale qui soit à la fois gratuite, fiable à cette échelle, et
STATIQUE — donc embarquable et utilisable hors réseau, ce qui est la règle de
cette application.

── POURQUOI UN RASTER, ET PAS LES POLYGONES ────────────────────────────────
Embarquer les polygones obligerait le téléphone à faire du point-dans-polygone
sur des milliers de contours, et à télécharger plusieurs mégaoctets. On les
rastérise ici, une fois : une grille d'environ 300 m de côté, compressée par
plages (RLE), quelques dizaines de kilo-octets, et une lecture en O(1) à bord.
La résolution de la source (1:250 000 pour les substrats) ne justifie de toute
façon pas mieux — prétendre au mètre près serait mentir sur la donnée.

── ROBUSTESSE ───────────────────────────────────────────────────────────────
Comme refresh_tide.py : les services EMODnet ne sont pas un contrat d'API. Le
script DÉCOUVRE les couches disponibles au lieu de coder en dur un nom qui
changera, essaie plusieurs points d'entrée, et sort en code 0 avec un rapport
de ce qu'il a vu s'il n'obtient rien. L'application fonctionne sans ce fichier ;
elle est seulement moins renseignée.
"""

from __future__ import annotations
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "seabed-dieppe.json")

# Secteur couvert : du Tréport à Fécamp, et 30 milles au large. C'est l'aire
# qu'un bateau de pêche côtier de Dieppe peut atteindre dans la journée.
SOUTH, NORTH = 49.55, 50.25
WEST, EAST = 0.35, 1.85

# Pas de la grille. 0,0025° de latitude ≈ 278 m ; 0,004° de longitude ≈ 286 m
# à 50°N. Grille carrée sur le terrain, ce qui n'est vrai qu'à cette latitude —
# l'app ne quitte pas la Manche orientale.
DLAT, DLON = 0.0025, 0.004

TIMEOUT = 120
UA = "Grim-s-Compagnon/1.0 (+https://github.com/qentinalouviers-sys/Grim-s)"

# Points d'entrée candidats, dans l'ordre de préférence. Le premier qui répond
# avec une couche exploitable gagne.
ENDPOINTS = [
    "https://ows.emodnet-seabedhabitats.eu/geoserver/emodnet_open/wfs",
    "https://ows.emodnet-seabedhabitats.eu/geoserver/emodnet_view/wfs",
    "https://ows.emodnet-seabedhabitats.eu/geoserver/wfs",
    "https://drive.emodnet-geology.eu/geoserver/seabed_substrate/wfs",
    "https://drive.emodnet-geology.eu/geoserver/wfs",
    "https://ows.emodnet-geology.eu/geoserver/wfs",
]

# Mots qui trahissent une couche de substrat, et leur poids.
#
# EUSeaMap passe devant « substrate » : le premier essai est tombé sur
# `biogenic_substrate_poly`, qui cartographie les récifs biogéniques — quatre
# polygones de Sabellaires — et non le sédiment. Le mot « substrat » ne suffit
# donc pas à désigner ce qu'on cherche.
LAYER_HINTS = [
    ("seabed_substrate", 12), ("eusm", 11), ("euseamap", 11),
    ("folk", 9), ("substrate", 6), ("sediment", 6), ("habitat", 2),
]
# Une couche au 1:1 000 000 existe aussi : on préfère la plus fine. Et tout ce
# qui est ponctuel, échantillonné ou biogénique n'est pas une carte de fond.
SCALE_BONUS = [
    ("250", 4), ("100k", 3), ("1m", -3), ("1000k", -3),
    ("biogenic", -12), ("point", -10), ("bbox", -10), ("sample", -8),
    ("survey", -6), ("boundar", -6), ("model_confidence", -8), ("uk", -2),
]

# Attributs candidats portant la classe de substrat.
ATTR_HINTS = ["folk_5cl", "folk_5", "substrate", "seabed_sub", "folk", "eunis", "classific", "descript"]

# Correspondance vers le vocabulaire de fonds déjà utilisé par l'app
# (js/fishing/spots.js, formulaire de marque). Volontairement conservatrice :
# ce qu'on ne sait pas traduire reste sans équivalent plutôt que rangé de force
# dans une case voisine.
HABITAT_MAP = [
    (("rock", "hard substrat", "roche", "reef", "boulder"), "roche"),
    (("coarse", "gravel", "pebble", "shell", "coquill"), "sable-coquillier"),
    (("muddy sand", "sandy mud", "sablo", "mixed"), "sablo-vaseux"),
    (("mud", "silt", "vase", "clay"), "vase"),
    (("sand", "sable"), "sable"),
    (("seabed", "sediment"), None),
]

# Libellés français des classes de Folk les plus courantes.
FR_LABELS = [
    (("rock", "hard substrat"), "Roche ou substrat dur"),
    (("coarse",), "Sédiment grossier (graviers, coquilles)"),
    (("mixed",), "Sédiment mixte"),
    (("muddy sand", "sandy mud"), "Sable vaseux"),
    (("sand",), "Sable"),
    (("mud",), "Vase"),
    (("seabed",), "Fond indéterminé"),
]


def log(msg: str) -> None:
    print(f"  {msg}", flush=True)


def fetch(url: str, timeout: int = TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ═══════════════════════════════════════════════════════════════════════════
# Découverte de la couche
# ═══════════════════════════════════════════════════════════════════════════
def list_layers(endpoint: str) -> list[str]:
    """Noms de couches annoncés par le GetCapabilities, toutes versions."""
    for version in ("2.0.0", "1.1.0"):
        url = f"{endpoint}?service=WFS&request=GetCapabilities&version={version}"
        try:
            xml = fetch(url, timeout=60).decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            log(f"capabilities {version} : {type(e).__name__}")
            continue
        names = re.findall(r"<(?:\w+:)?Name>([^<]+)</(?:\w+:)?Name>", xml)
        # Le premier Name est celui du service, pas d'une couche.
        names = [n.strip() for n in names if ":" in n or "_" in n]
        if names:
            return sorted(set(names))
    return []


def score_layer(name: str) -> int:
    low = name.lower()
    score = 0
    for word, pts in LAYER_HINTS:
        if word in low:
            score += pts
    for word, pts in SCALE_BONUS:
        if word in low:
            score += pts
    return score


def get_features(endpoint: str, layer: str) -> dict | None:
    """GetFeature en GeoJSON sur l'emprise, en essayant les deux conventions
    d'axes : WFS 2.0 impose lat/lon en EPSG:4326, ce que tout le monde
    n'applique pas de la même façon."""
    variants = [
        {"version": "2.0.0", "typenames": layer, "count": "8000",
         "bbox": f"{SOUTH},{WEST},{NORTH},{EAST},urn:ogc:def:crs:EPSG::4326"},
        {"version": "2.0.0", "typenames": layer, "count": "8000",
         "bbox": f"{WEST},{SOUTH},{EAST},{NORTH},EPSG:4326"},
        {"version": "1.1.0", "typename": layer, "maxFeatures": "8000",
         "bbox": f"{WEST},{SOUTH},{EAST},{NORTH},EPSG:4326"},
    ]
    for params in variants:
        q = {"service": "WFS", "request": "GetFeature",
             "outputFormat": "application/json", "srsName": "EPSG:4326", **params}
        url = f"{endpoint}?{urllib.parse.urlencode(q)}"
        try:
            raw = fetch(url)
        except Exception as e:  # noqa: BLE001
            log(f"GetFeature ({params['version']}) : {type(e).__name__}")
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            log(f"GetFeature ({params['version']}) : réponse non JSON "
                f"({raw[:120].decode('utf-8', 'replace')!r})")
            continue
        feats = data.get("features") or []
        if feats:
            log(f"{len(feats)} polygones reçus ({params['version']})")
            return data
        log(f"GetFeature ({params['version']}) : 0 polygone")
    return None


def pick_attribute(features: list[dict]) -> str | None:
    props = {}
    for f in features[:50]:
        for k, v in (f.get("properties") or {}).items():
            if isinstance(v, str) and v.strip():
                props.setdefault(k.lower(), k)
    for hint in ATTR_HINTS:
        for low, original in props.items():
            if hint in low:
                return original
    return None


# ═══════════════════════════════════════════════════════════════════════════
# Rastérisation
# ═══════════════════════════════════════════════════════════════════════════
def rings_of(geom: dict) -> list[list[list[float]]]:
    """Anneaux (extérieur + trous) d'un Polygon ou MultiPolygon."""
    t = geom.get("type")
    if t == "Polygon":
        return geom.get("coordinates") or []
    if t == "MultiPolygon":
        out = []
        for poly in geom.get("coordinates") or []:
            out.extend(poly)
        return out
    return []


def edges_of(rings: list) -> list[tuple[float, float, float, float]]:
    """Arêtes non horizontales, sous forme (y_bas, y_haut, x_au_y_bas, pente)."""
    out = []
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
            if y1 == y2:
                continue          # une arête horizontale ne coupe aucune ligne
            if y1 < y2:
                out.append((y1, y2, x1, (x2 - x1) / (y2 - y1)))
            else:
                out.append((y2, y1, x2, (x1 - x2) / (y1 - y2)))
    return out


def rasterise(features: list[dict], attribute: str) -> tuple[list[int], list[str], int, int]:
    """
    Balayage par lignes, et c'est le seul choix tenable.

    La version naïve — tester chaque cellule contre chaque contour — coûte
    « cellules × sommets ». Les polygones d'EUSeaMap comptent des milliers de
    sommets chacun : le premier passage réel tournait encore au bout de dix
    minutes. Ici, pour chaque ligne de la grille on calcule UNE fois les
    intersections des arêtes, on les trie, et on remplit les intervalles entre
    elles deux à deux (règle pair-impair, qui rend les trous du GeoJSON
    gratuitement). Le coût retombe à « lignes × sommets ».
    """
    rows = int(round((NORTH - SOUTH) / DLAT))
    cols = int(round((EAST - WEST) / DLON))
    grid = [0] * (rows * cols)          # 0 = inconnu
    labels: list[str] = []
    index: dict[str, int] = {}

    for f in features:
        raw = (f.get("properties") or {}).get(attribute)
        if not isinstance(raw, str) or not raw.strip():
            continue
        label = raw.strip()
        if label not in index:
            labels.append(label)
            index[label] = len(labels)   # 1-based, 0 reste « inconnu »
        cls = index[label]

        rings = rings_of(f.get("geometry") or {})
        if not rings:
            continue
        edges = edges_of(rings)
        if not edges:
            continue

        ymin = min(e[0] for e in edges)
        ymax = max(e[1] for e in edges)
        i0 = max(0, int((ymin - SOUTH) / DLAT))
        i1 = min(rows - 1, int((ymax - SOUTH) / DLAT) + 1)

        for i in range(i0, i1 + 1):
            y = SOUTH + (i + 0.5) * DLAT
            xs = [x0 + (y - y0) * slope for y0, y1, x0, slope in edges if y0 <= y < y1]
            if len(xs) < 2:
                continue
            xs.sort()
            base = i * cols
            for k in range(0, len(xs) - 1, 2):
                ja = max(0, int(-(-((xs[k] - WEST) / DLON - 0.5) // 1)))      # ceil
                jb = min(cols - 1, int((xs[k + 1] - WEST) / DLON - 0.5))      # floor
                for j in range(ja, jb + 1):
                    if not grid[base + j]:
                        grid[base + j] = cls
    return grid, labels, rows, cols


def rle(grid: list[int]) -> list[int]:
    out: list[int] = []
    if not grid:
        return out
    cur = grid[0]
    run = 1
    for v in grid[1:]:
        if v == cur and run < 65535:
            run += 1
        else:
            out.extend((run, cur))
            cur, run = v, 1
    out.extend((run, cur))
    return out


def translate(label: str) -> tuple[str, str | None]:
    low = label.lower()
    fr = label
    for words, name in FR_LABELS:
        if any(w in low for w in words):
            fr = name
            break
    habitat = None
    for words, name in HABITAT_MAP:
        if any(w in low for w in words):
            habitat = name
            break
    return fr, habitat


# ═══════════════════════════════════════════════════════════════════════════
def main() -> int:
    print("Nature des fonds — EMODnet")
    features = None
    used_endpoint = used_layer = None
    seen: dict[str, list[str]] = {}

    attribute = None
    for endpoint in ENDPOINTS:
        log(f"→ {endpoint}")
        layers = list_layers(endpoint)
        if not layers:
            continue
        seen[endpoint] = layers
        ranked = sorted(((score_layer(n), n) for n in layers), reverse=True)
        log(f"{len(layers)} couches, meilleures : {[n for s, n in ranked[:6] if s > 0]}")

        # Une couche qui répond mais ne porte pas d'attribut de substrat n'est
        # pas la bonne : on passe à la suivante au lieu d'abandonner. C'est ce
        # qui manquait au premier passage — il s'est arrêté sur des récifs
        # biogéniques et n'a jamais regardé EUSeaMap.
        for score, name in ranked[:12]:
            if score <= 0:
                break
            log(f"essai « {name} » (score {score})")
            data = get_features(endpoint, name)
            feats = (data or {}).get("features") or []
            if not feats:
                continue
            attr = pick_attribute(feats)
            if not attr:
                log(f"  → pas d'attribut de substrat : {list((feats[0].get('properties') or {}).keys())}")
                continue
            features, attribute = feats, attr
            used_endpoint, used_layer = endpoint, name
            break
        if features:
            break

    if not features or not attribute:
        log("aucune couche exploitable — l'app continue sans nature des fonds.")
        log("couches vues, pour affiner le script :")
        for ep, names in seen.items():
            for n in names:
                log(f"  {ep} :: {n}")
        return 0

    log(f"attribut retenu : {attribute}")

    grid, labels, rows, cols = rasterise(features, attribute)
    filled = sum(1 for v in grid if v)
    log(f"grille {rows}×{cols}, {filled} cellules renseignées "
        f"({100 * filled / len(grid):.1f} %), {len(labels)} classes")
    if filled == 0:
        log("grille vide — rien à écrire.")
        return 0

    classes = [{"label": "Inconnu", "fr": "Fond non renseigné", "habitat": None}]
    for label in labels:
        fr, habitat = translate(label)
        classes.append({"label": label, "fr": fr, "habitat": habitat})

    payload = {
        "source": "EMODnet Seabed Habitats / Geology",
        "endpoint": used_endpoint,
        "layer": used_layer,
        "attribute": attribute,
        "licence": "CC-BY 4.0 — EMODnet",
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "bbox": [SOUTH, WEST, NORTH, EAST],
        "step": [DLAT, DLON],
        "size": [rows, cols],
        "classes": classes,
        "rle": rle(grid),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    log(f"écrit {OUT} ({os.path.getsize(OUT) / 1024:.0f} ko)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

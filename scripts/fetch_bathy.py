#!/usr/bin/env python3
"""
fetch_bathy.py — sonde du secteur de Dieppe, depuis EMODnet Bathymetry.

Produit : data/bathy-dieppe.json

── POURQUOI CETTE DONNÉE ────────────────────────────────────────────────────
La nature du fond dit CE QU'IL Y A ; la sonde dit OÙ SE PLACER. Un pêcheur de
bar ne cherche pas « de la roche », il cherche une CASSURE : le bord d'un
ridin, un tombant, la lèvre d'une fosse — l'endroit où le courant décolle et
concentre le fourrage. C'est de la topographie, et la topographie sous-marine
est publique.

EMODnet Bathymetry publie un modèle numérique de terrain de la Manche à
1/16 de minute d'arc, soit environ 115 m. Licence CC-BY. C'est la seule
donnée de relief à la fois gratuite, homogène sur toute la zone, et STATIQUE —
donc embarquable et utilisable sans réseau, ce qui est la règle de l'app.

── CE QU'ELLE NE PERMET PAS ────────────────────────────────────────────────
À 115 m de maille, un ridin isolé — 2 à 3 m de haut, quelques centaines de
mètres de longueur d'onde — est à la limite de la résolution. On voit les
GRANDES structures : le plateau côtier et sa cassure, les fosses, les bancs du
large, la fosse du chenal. On ne voit pas la ride individuelle. L'app le dit ;
le sondeur du bord reste le juge.

── FORMAT ───────────────────────────────────────────────────────────────────
On DEMANDE au service ce qu'il sait produire (DescribeCoverage) et on prend le
premier format qu'on sait lire. Le premier passage avait codé ArcGrid en dur —
du texte, idéal pour un job sans GDAL — et s'est fait répondre « format ArcGrid
is not supported for this coverage ». D'où un petit lecteur GeoTIFF maison, en
bibliothèque standard : quatre-vingts lignes contre une dépendance système de
deux cents mégaoctets dans un job qui tourne une fois par an.

On agrège ensuite 2×2, on quantifie au mètre, puis on encode la différence
d'une case à la suivante en RLE. Le fond de la Manche est lisse : la plupart
des différences valent zéro, et le fichier tombe à quelques dizaines de
kilo-octets.

── ROBUSTESSE ───────────────────────────────────────────────────────────────
Comme fetch_seabed.py : le script DÉCOUVRE la couverture et les formats
disponibles au lieu de coder en dur des noms qui changeront, et sort en code 0
avec un rapport de ce qu'il a vu s'il n'obtient rien. L'application fonctionne
sans ce fichier ; elle est seulement moins renseignée.

── ÉTAT AU 15 AOÛT 2026 : CE SCRIPT NE RAPPORTE RIEN, ET C'EST VOULU ────────
Quatre passages en conditions réelles ont établi que le point d'entrée
https://ows.emodnet-bathymetry.eu/wcs ne sert PAS le modèle de terrain. Il
répond, il découpe, il livre un GeoTIFF parfaitement formé — sur UNE BANDE DE
HUIT BITS. C'est un rendu colorié : les valeurs sont des index de palette de 0
à 255, pas des mètres.

Le troisième passage l'a d'ailleurs livré tel quel, et le fichier annonçait des
sondes de 1 à 253 m avec un mode vers 120 m. Personne n'aurait tiqué sans
connaître le coin : 120 m, c'est l'altitude du plateau de Caux, lue comme une
profondeur. D'où les deux garde-fous qui restent ici et qui sont le vrai
résultat de ce travail :

  1. une bande de huit bits n'est jamais un MNT, quel que soit son en-tête ;
  2. le coin nord-ouest de l'emprise est à trente milles au large de Fécamp,
     donc sous 5 à 90 m d'eau. Toute grille qui prétend autre chose est
     refusée, sans discussion.

Pour obtenir la vraie donnée il faut passer par le portail de téléchargement
d'EMODnet Bathymetry : les tuiles du DTM en NetCDF ou GeoTIFF, une centaine de
mégaoctets par tuile, à réduire dans ce même job. C'est un travail distinct et
plus lourd que ce collecteur, et il vaut d'être fait — la sonde est la donnée
qui manque le plus à l'app. En attendant, mieux vaut rien qu'une carte fausse.
"""

from __future__ import annotations
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "bathy-dieppe.json")

# Même emprise que la carte des fonds : du Tréport à Fécamp, 30 milles au large.
SOUTH, NORTH = 49.55, 50.25
WEST, EAST = 0.35, 1.85

# Pas demandé au service. ArcGrid impose une case carrée EN DEGRÉS : 0,0015°
# fait 167 m en latitude et 107 m en longitude à 50°N, ce qui encadre la
# résolution native de 115 m sans prétendre faire mieux qu'elle.
FINE = 0.0015
# Agrégation 2×2 pour la grille embarquée : 0,003° = 334 m × 214 m.
AGG = 2

TIMEOUT = 180
UA = "Grim-s-Compagnon/1.0 (+https://github.com/qentinalouviers-sys/Grim-s)"

ENDPOINTS = [
    "https://ows.emodnet-bathymetry.eu/wcs",
    "https://ows.emodnet-bathymetry.eu/geoserver/wcs",
    "https://ows.emodnet-bathymetry.eu/geoserver/emodnet/wcs",
]

# Couvertures candidates, préférence décroissante. `mean` est la profondeur
# moyenne du MNT ; les autres existent selon les millésimes du service.
COVERAGE_HINTS = [
    ("emodnet:mean", 10), ("mean", 9),
    ("emodnet:dtm", 6), ("dtm", 5), ("elevation", 4), ("depth", 4),
]
# Ce qu'on ne veut surtout pas : les couches de qualité, de source ou d'écart
# type portent le même préfixe et la même emprise, et se téléchargent aussi
# bien — silencieusement fausses.
COVERAGE_VETO = ("quality", "source", "stdev", "std_dev", "cdi", "count", "mask")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url: str, timeout: int = TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ══ 1. Découverte ═════════════════════════════════════════════════════════
def discover(endpoint: str) -> list[str]:
    """Noms de couverture annoncés par GetCapabilities, ordre du service."""
    url = f"{endpoint}?service=WCS&version=1.0.0&request=GetCapabilities"
    xml = get(url, timeout=90).decode("utf-8", "replace")
    # WCS 1.0.0 : <name>; WCS 2.0 : <wcs:CoverageId>. On accepte les deux.
    names = re.findall(r"<(?:\w+:)?(?:name|CoverageId)>([^<]+)</", xml, re.I)
    seen, out = set(), []
    for n in names:
        n = n.strip()
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def rank(name: str) -> int:
    low = name.lower()
    if any(v in low for v in COVERAGE_VETO):
        return -1
    best = 0
    for hint, w in COVERAGE_HINTS:
        if low == hint.lower():
            return w + 5          # correspondance exacte : rien ne la bat
        if hint.lower() in low:
            best = max(best, w)
    return best


# ══ 2. Téléchargement ═════════════════════════════════════════════════════
# Le premier passage a demandé ArcGrid — du texte, parfait pour un job sans
# GDAL — et le service a répondu « format ArcGrid is not supported for this
# coverage ». On ne devine plus : on DEMANDE au service ce qu'il sait produire,
# et on prend le premier format qu'on sait lire.
FORMAT_PREFS = ["arcgrid", "geotiff", "tiff", "image/tiff"]


def supported_formats(endpoint: str, coverage: str) -> list[str]:
    url = (f"{endpoint}?service=WCS&version=1.0.0&request=DescribeCoverage"
           f"&coverage={urllib.parse.quote(coverage)}")
    try:
        xml = get(url, timeout=60).decode("utf-8", "replace")
    except Exception:                                           # noqa: BLE001
        return []
    return [f.strip() for f in re.findall(r"<(?:\w+:)?formats>([^<]+)</", xml, re.I)]


# Côté maximal d'une tuile demandée. Le service a refusé 1000 × 467 avec
# « An error occurred while checking serving limits » : il y a un plafond, il
# n'est pas documenté, et on ne le contourne pas en insistant. On découpe.
TILE_MAX = 320


def one_request(endpoint: str, coverage: str, fmt: str, box, w: int, h: int,
                version: str = "1.0.0"):
    if version.startswith("2"):
        # En WCS 2.0 le découpage se déclare par sous-ensembles nommés, et
        # GeoServer y sert la donnée brute là où la 1.0.0 applique volontiers
        # le style d'affichage de la couche.
        params = {
            "service": "WCS",
            "version": "2.0.1",
            "request": "GetCoverage",
            "coverageId": coverage,
            "format": fmt,
            "subset": f"Lat({box[1]},{box[3]})",
        }
        qs = urllib.parse.urlencode(params) + "&" + urllib.parse.urlencode(
            {"subset": f"Long({box[0]},{box[2]})"})
        raw = get(f"{endpoint}?{qs}")
    else:
        params = {
            "service": "WCS",
            "version": "1.0.0",
            "request": "GetCoverage",
            "coverage": coverage,
            "crs": "EPSG:4326",
            "bbox": f"{box[0]},{box[1]},{box[2]},{box[3]}",
            "width": str(w),
            "height": str(h),
            "format": fmt,
        }
        raw = get(f"{endpoint}?{urllib.parse.urlencode(params)}")
    if raw[:2] in (b"II", b"MM"):
        return "tiff", raw
    txt = raw.decode("utf-8", "replace")
    if re.match(r"\s*ncols", txt, re.I):
        return "ascii", txt
    return None, txt[:170].replace("\n", " ")


def fetch_grid(endpoint: str, coverage: str):
    """
    Grille complète de l'emprise, assemblée à partir de tuiles.

    Renvoie la matrice ligne 0 = NORD, comme ArcGrid et comme GeoTIFF, ou None.
    """
    cols = int(round((EAST - WEST) / FINE))
    rows = int(round((NORTH - SOUTH) / FINE))
    offered = supported_formats(endpoint, coverage)
    log(f"    formats annoncés : {', '.join(offered) or '(aucun)'}")

    order = []
    for pref in FORMAT_PREFS:
        for f in offered:
            if pref in f.lower() and f not in order:
                order.append(f)
    for fallback in ("GeoTIFF", "ArcGrid", "image/tiff"):
        if fallback not in order:
            order.append(fallback)

    nx = (cols + TILE_MAX - 1) // TILE_MAX
    ny = (rows + TILE_MAX - 1) // TILE_MAX

    attempts = [(f, v) for f in order for v in ("1.0.0", "2.0.1")]
    for fmt, version in attempts:
        grid: list[list[float | None]] = [[None] * cols for _ in range(rows)]
        ok = True
        log(f"    {cols}×{rows} en {fmt} (WCS {version}), {nx}×{ny} tuiles …")
        for ty in range(ny):
            for tx in range(nx):
                # Les bornes sont calculées EN CASES puis converties, jamais
                # l'inverse : additionner des degrés flottants tuile après
                # tuile décale l'assemblage d'une demi-case au bout de la
                # quatrième, et le raccord se voit comme une faille.
                c0, c1 = tx * TILE_MAX, min(cols, (tx + 1) * TILE_MAX)
                r0, r1 = ty * TILE_MAX, min(rows, (ty + 1) * TILE_MAX)
                w, h = c1 - c0, r1 - r0
                west = WEST + c0 * FINE
                east = WEST + c1 * FINE
                # r0 se compte depuis le NORD, comme la matrice de sortie.
                north = NORTH - r0 * FINE
                south = NORTH - r1 * FINE
                try:
                    kind, payload = one_request(endpoint, coverage, fmt,
                                                (west, south, east, north), w, h, version)
                except Exception as e:                          # noqa: BLE001
                    log(f"      ✗ tuile {tx},{ty} : {e}")
                    ok = False
                    break
                if not kind:
                    log(f"      ✗ tuile {tx},{ty} : {payload}")
                    ok = False
                    break
                if kind == "ascii":
                    _, sub = parse_arcgrid(payload)
                else:
                    sw, sh, sub = read_tiff(payload)
                    if (sw, sh) != (w, h):
                        # En WCS 2.0 c'est le service qui décide de la taille :
                        # tant que l'écart reste marginal on recadre, au-delà
                        # c'est que le découpage n'a pas été compris.
                        if abs(sw - w) > 2 or abs(sh - h) > 2:
                            log(f"      ✗ tuile {tx},{ty} : {sw}×{sh} au lieu de {w}×{h}")
                            ok = False
                            break
                        sub = [row[:w] for row in sub[:h]]
                        while len(sub) < h:
                            sub.append([None] * w)
                        sub = [(r + [None] * w)[:w] for r in sub]
                for r in range(h):
                    grid[r0 + r][c0:c1] = sub[r][:w]
            if not ok:
                break
        if ok:
            filled = sum(1 for row in grid for v in row if v is not None)
            log(f"    ✓ assemblé, {filled}/{cols * rows} cases renseignées")
            return grid
    return None


def parse_arcgrid(txt: str) -> tuple[dict, list[list[float]]]:
    """En-tête ESRI + matrice. Ligne 0 = NORD (convention ArcGrid)."""
    head: dict = {}
    lines = txt.splitlines()
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        if len(parts) == 2 and re.match(r"^[a-zA-Z_]+$", parts[0]):
            head[parts[0].lower()] = float(parts[1])
            i += 1
        else:
            break
    ncols, nrows = int(head["ncols"]), int(head["nrows"])
    nodata = head.get("nodata_value", -9999.0)

    # Le corps peut être libre en sauts de ligne : on lit un flot de nombres.
    vals: list[float] = []
    for line in lines[i:]:
        for tok in line.split():
            vals.append(float(tok))
    if len(vals) < ncols * nrows:
        raise ValueError(f"grille tronquée : {len(vals)} < {ncols * nrows}")

    grid = []
    for r in range(nrows):
        row = vals[r * ncols:(r + 1) * ncols]
        grid.append([None if abs(v - nodata) < 1e-6 else v for v in row])
    return {"ncols": ncols, "nrows": nrows, "nodata": nodata}, grid


# ══ 2 bis. Lecture d'un GeoTIFF, sans GDAL ni numpy ═══════════════════════
# Quatre-vingts lignes contre une dépendance système de deux cents mégaoctets
# dans un job qui tourne une fois par an. Le TIFF produit par GeoServer est un
# cas simple : une bande, float ou entier, en bandes ou en tuiles, sans
# compression ou en deflate — que la bibliothèque standard sait défaire.
TAGS = {
    256: "width", 257: "height", 258: "bits", 259: "compression",
    273: "stripOffsets", 277: "samples", 278: "rowsPerStrip", 279: "stripBytes",
    317: "predictor", 322: "tileWidth", 323: "tileHeight",
    324: "tileOffsets", 325: "tileBytes", 339: "sampleFormat", 42113: "nodata",
}
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


def clean(v, nodata):
    """NaN et sentinelle deviennent « pas de mesure ».

    EMODnet marque l'absence de donnée tantôt par une valeur sentinelle, tantôt
    par un NaN IEEE. Un NaN qui survit jusqu'à la moyenne empoisonne toute la
    case agrégée — silencieusement, puisque NaN n'est ni None ni une erreur."""
    if v != v:
        return None
    if nodata is not None and abs(v - nodata) < 1e-6:
        return None
    # Sous -12 000 m on est sous la fosse des Mariannes : c'est une sentinelle.
    if v < -12000 or v > 9000:
        return None
    return float(v)


def read_tiff(raw: bytes) -> tuple[int, int, list[list[float | None]]]:
    import struct
    import zlib

    endian = "<" if raw[:2] == b"II" else ">"
    magic, first = struct.unpack_from(endian + "HI", raw, 2)
    if magic != 42:
        raise ValueError("BigTIFF non géré")

    tags: dict = {}
    count = struct.unpack_from(endian + "H", raw, first)[0]
    for i in range(count):
        off = first + 2 + i * 12
        tag, typ, n = struct.unpack_from(endian + "HHI", raw, off)
        size = TYPE_SIZE.get(typ, 1) * n
        payload = off + 8
        if size > 4:
            payload = struct.unpack_from(endian + "I", raw, off + 8)[0]
        name = TAGS.get(tag)
        if not name:
            continue
        if typ == 2:
            tags[name] = raw[payload:payload + n].split(b"\0")[0].decode("ascii", "replace")
            continue
        code = {1: "B", 3: "H", 4: "I", 8: "h", 9: "i", 11: "f", 12: "d"}.get(typ)
        if not code:
            continue
        tags[name] = list(struct.unpack_from(endian + code * n, raw, payload))

    def one(name, default=None):
        v = tags.get(name)
        if v is None:
            return default
        return v[0] if isinstance(v, list) else v

    w, h = one("width"), one("height")
    bits = one("bits", 32)
    fmt = one("sampleFormat", 1)
    comp = one("compression", 1)
    pred = one("predictor", 1)
    if one("samples", 1) != 1:
        raise ValueError("plusieurs bandes — couverture inattendue")
    if pred not in (1,):
        raise ValueError(f"prédicteur {pred} non géré")
    if comp not in (1, 8, 32946):
        raise ValueError(f"compression {comp} non gérée")

    # Un modèle numérique de terrain n'est JAMAIS sur huit bits. Quand le
    # service renvoie une bande de 0 à 255, il a servi un RENDU — une image
    # coloriée — et pas des mètres. Le premier passage a livré une grille
    # « 1 à 253 m » avec un mode vers 120 m, dans une Manche orientale qui fait
    # 10 à 65 m : parfaitement plausible à l'œil, entièrement fausse. C'est
    # exactement le genre de donnée qu'il vaut mieux ne pas avoir.
    if bits <= 8:
        raise ValueError(f"bande {bits} bits — rendu colorié, pas un MNT")
    code = {(32, 3): "f", (64, 3): "d", (16, 2): "h", (16, 1): "H",
            (32, 2): "i", (32, 1): "I"}.get((bits, fmt))
    if not code:
        raise ValueError(f"échantillon {bits} bits format {fmt} non géré")
    px = bits // 8

    nodata = None
    if tags.get("nodata"):
        try:
            nodata = float(tags["nodata"])
        except (TypeError, ValueError):
            nodata = None

    def blob(off, n):
        b = raw[off:off + n]
        return zlib.decompress(b) if comp in (8, 32946) else b

    grid: list[list[float | None]] = [[None] * w for _ in range(h)]

    if tags.get("tileOffsets"):
        tw, th = one("tileWidth"), one("tileHeight")
        across = (w + tw - 1) // tw
        offs, lens = tags["tileOffsets"], tags["tileBytes"]
        for idx, (off, n) in enumerate(zip(offs, lens)):
            data = blob(off, n)
            tx, ty = (idx % across) * tw, (idx // across) * th
            for r in range(th):
                y = ty + r
                if y >= h:
                    break
                base = r * tw * px
                row = struct.unpack_from(endian + code * tw, data, base)
                for c in range(tw):
                    x = tx + c
                    if x >= w:
                        break
                    grid[y][x] = clean(row[c], nodata)
    else:
        rps = one("rowsPerStrip", h)
        offs, lens = tags["stripOffsets"], tags["stripBytes"]
        y = 0
        for off, n in zip(offs, lens):
            data = blob(off, n)
            rows_here = min(rps, h - y)
            for r in range(rows_here):
                row = struct.unpack_from(endian + code * w, data, r * w * px)
                for c in range(w):
                    grid[y][c] = clean(row[c], nodata)
                y += 1
    return w, h, grid


# ══ 3. Agrégation ═════════════════════════════════════════════════════════
def aggregate(grid: list[list[float | None]]) -> tuple[list[list[int | None]], int, int]:
    """Moyenne AGG×AGG. Renvoie la grille en mètres entiers, ligne 0 = SUD."""
    nrows, ncols = len(grid), len(grid[0])
    orows, ocols = nrows // AGG, ncols // AGG
    out: list[list[int | None]] = []
    for r in range(orows):
        row: list[int | None] = []
        for c in range(ocols):
            acc, n = 0.0, 0
            for dr in range(AGG):
                for dc in range(AGG):
                    v = grid[r * AGG + dr][c * AGG + dc]
                    if v is not None:
                        acc += v
                        n += 1
            row.append(None if n == 0 else int(round(acc / n)))
        out.append(row)
    # ArcGrid descend du nord ; l'app raisonne du sud, comme la carte des fonds.
    out.reverse()
    return out, orows, ocols


# ══ 4. Encodage ═══════════════════════════════════════════════════════════
# EMODnet donne des ÉLÉVATIONS : négatives sous le niveau de la mer. L'app
# parle de SONDE, positive vers le bas — c'est ce que dit le sondeur du bord,
# et ce que dit la carte marine.
LAND = 32767          # sentinelle : au-dessus du zéro, donc pas de la mer
NODATA = 32766        # pas de mesure


def encode(grid: list[list[int | None]], sign: int = -1) -> list[int]:
    """
    Différences successives, en RLE : [valeur, répétitions, valeur, …].

    Le fond de la Manche est lisse à 300 m de maille : d'une case à l'autre la
    sonde bouge rarement de plus d'un mètre, et souvent pas du tout. Encoder la
    différence plutôt que la valeur transforme la grille en longues plages de
    zéros, que le RLE écrase. Mesuré sur le secteur : 117 000 cases → 25 kio.
    """
    flat: list[int] = []
    for row in grid:
        for v in row:
            if v is None:
                flat.append(NODATA)
            else:
                d = sign * v            # élévation → sonde, ou sonde telle quelle
                flat.append(LAND if d < 0 else min(d, 3000))

    out: list[int] = []
    prev = 0
    run_val, run_len = None, 0
    for v in flat:
        # Les sentinelles cassent la chaîne des différences : on les code telles
        # quelles, sinon un bout de côte fait exploser le delta suivant.
        d = (v - prev) if v < 30000 and prev < 30000 else v
        if v < 30000:
            prev = v
        if d == run_val:
            run_len += 1
        else:
            if run_val is not None:
                out.extend((run_val, run_len))
            run_val, run_len = d, 1
    if run_val is not None:
        out.extend((run_val, run_len))
    return out


def decode(codes: list[int], count: int) -> list[int]:
    """Miroir de encode(), pour le contrôle de cohérence."""
    out: list[int] = []
    prev = 0
    for i in range(0, len(codes), 2):
        d, n = codes[i], codes[i + 1]
        for _ in range(n):
            if d >= 30000:
                out.append(d)
            else:
                prev = prev + d
                out.append(prev)
    if len(out) != count:
        raise ValueError(f"décodage : {len(out)} ≠ {count}")
    return out


# ══ 5. Programme ══════════════════════════════════════════════════════════
def main() -> int:
    report = []
    for endpoint in ENDPOINTS:
        log(f"→ {endpoint}")
        try:
            names = discover(endpoint)
        except Exception as e:                                  # noqa: BLE001
            log(f"  ✗ capabilities : {e}")
            report.append(f"{endpoint} : {e}")
            continue
        ranked = sorted(((rank(n), n) for n in names), reverse=True)
        ranked = [(s, n) for s, n in ranked if s > 0]
        log(f"  {len(names)} couvertures, {len(ranked)} candidates")
        for score, cov in ranked[:4]:
            log(f"  · essai {cov} (score {score})")
            try:
                grid = fetch_grid(endpoint, cov)
                if not grid:
                    continue
                # ArcGrid comme GeoTIFF descendent du nord ; aggregate()
                # retourne la grille pour que la ligne 0 soit le bord sud.
                agg, _, _ = aggregate(grid)
                rows, cols = len(agg), len(agg[0])
                total = rows * cols

                # ── Sens de la convention ────────────────────────────────
                # EMODnet publie des ÉLÉVATIONS (négatives sous la mer), mais
                # rien ne garantit que la couverture servie suive la même
                # convention. On ne suppose donc pas — on regarde un endroit
                # dont on SAIT qu'il est de l'eau.
                #
                # La première version de ce test comptait les valeurs comprises
                # entre 2 et 200 et prenait le signe majoritaire. Elle s'est
                # trompée, et de la pire façon : le plateau de Caux culmine à
                # 100-150 m d'altitude et occupe la moitié du rectangle, si
                # bien que « majorité de valeurs entre 2 et 200 » désignait la
                # TERRE. La grille livrée annonçait des sondes de 1 à 253 m avec
                # un mode vers 120 m — c'était l'altitude des falaises, lue à
                # l'envers, et rien dans le fichier ne le disait.
                #
                # Le coin nord-ouest de l'emprise est à trente milles au large
                # de Fécamp. C'est de l'eau, toujours, quelle que soit la
                # marée. Son signe donne la convention, sans arbitrage.
                i0 = int(len(agg) * 0.85)
                j1 = int(len(agg[0]) * 0.18)
                probe = [v for r in agg[i0:] for v in r[:j1] if v is not None]
                vals = [v for r in agg for v in r if v is not None]
                if not vals or len(probe) < 50:
                    log("    ✗ grille vide ou coin large non renseigné")
                    continue
                probe.sort()
                med_probe = probe[len(probe) // 2]
                sign = -1 if med_probe < 0 else 1
                depths = [sign * v for v in vals if sign * v > 0]
                sea = sum(1 for d in depths if 2 <= d <= 200)
                vals.sort()
                log(f"    coin du large : médiane {med_probe} sur {len(probe)} cases "
                    f"→ convention {'élévation' if sign < 0 else 'sonde'}")
                log(f"    valeurs : min {vals[0]}, médiane {vals[len(vals) // 2]}, max {vals[-1]}")
                if not (5 <= abs(med_probe) <= 90):
                    log(f"    ✗ {abs(med_probe)} m au large de Fécamp — la Manche "
                        "orientale fait 10 à 60 m, ce n'est pas une sonde")
                    continue
                if sea < total * 0.2:
                    log(f"    ✗ {sea}/{total} cases de mer plausible — trop peu")
                    continue

                codes = encode(agg, sign)
                flat = [v for r in agg for v in r]
                decode(codes, len(flat))        # ceinture et bretelles

                doc = {
                    "_comment": [
                        "Sonde du secteur de Dieppe, en mètres sous le zéro des cartes.",
                        "Source : EMODnet Bathymetry, MNT à 1/16 de minute d'arc (~115 m).",
                        "Agrégée ici à ~300 m : on y lit les cassures et les fosses,",
                        "pas la ride individuelle. Le sondeur du bord reste le juge.",
                        "",
                        "grid : différences successives en RLE [valeur, répétitions, ...].",
                        f"{LAND} = au-dessus du zéro (terre, estran), {NODATA} = pas de mesure.",
                        "Ligne 0 = bord SUD. Colonne 0 = bord OUEST.",
                    ],
                    "source": "EMODnet Bathymetry",
                    "coverage": cov,
                    "endpoint": endpoint,
                    "licence": "CC-BY 4.0 — EMODnet Bathymetry",
                    "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "bbox": [SOUTH, WEST, NORTH, EAST],
                    "size": [rows, cols],
                    "step": [round((NORTH - SOUTH) / rows, 6), round((EAST - WEST) / cols, 6)],
                    "resolutionM": int(round(FINE * AGG * 111320 * math.cos(math.radians(49.9)))),
                    "land": LAND,
                    "nodata": NODATA,
                    "depthRangeM": [min(depths), max(depths)],
                    "seaCoverage": round(sea / total, 3),
                    "grid": codes,
                }
                os.makedirs(os.path.dirname(OUT), exist_ok=True)
                with open(OUT, "w", encoding="utf-8") as f:
                    json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
                size = os.path.getsize(OUT)
                log(f"    ✓ {rows}×{cols}, sonde {min(depths)}–{max(depths)} m, "
                    f"{sea / total:.1%} en mer, {size // 1024} kio")
                return 0
            except Exception as e:                              # noqa: BLE001
                log(f"    ✗ {e}")
                report.append(f"{cov} : {e}")

    log("\nAucune couverture exploitable. Vu :")
    for line in report[:20]:
        log(f"  · {line}")
    log("L'app fonctionne sans ce fichier — elle est seulement moins renseignée.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

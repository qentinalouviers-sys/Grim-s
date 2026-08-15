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
On demande une grille ASCII (ArcGrid) — du texte, lisible sans GDAL ni numpy,
donc sans dépendance dans le job CI. On l'agrège 2×2, on quantifie au mètre,
puis on encode la différence d'une case à la suivante en RLE. Le fond de la
Manche est lisse : la plupart des différences valent zéro, et le fichier tombe
à quelques dizaines de kilo-octets.

── ROBUSTESSE ───────────────────────────────────────────────────────────────
Comme fetch_seabed.py : le script DÉCOUVRE la couverture et les formats
disponibles au lieu de coder en dur des noms qui changeront, et sort en code 0
avec un rapport de ce qu'il a vu s'il n'obtient rien. L'application fonctionne
sans ce fichier ; elle est seulement moins renseignée.
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
def fetch_grid(endpoint: str, coverage: str) -> str | None:
    """Une grille ASCII couvrant l'emprise, ou None."""
    cols = int(round((EAST - WEST) / FINE))
    rows = int(round((NORTH - SOUTH) / FINE))
    params = {
        "service": "WCS",
        "version": "1.0.0",
        "request": "GetCoverage",
        "coverage": coverage,
        "crs": "EPSG:4326",
        "bbox": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "width": str(cols),
        "height": str(rows),
        "format": "ArcGrid",
    }
    url = f"{endpoint}?{urllib.parse.urlencode(params)}"
    log(f"    GetCoverage {cols}×{rows} …")
    raw = get(url)
    txt = raw.decode("utf-8", "replace")
    if not re.match(r"\s*ncols", txt, re.I):
        head = txt[:220].replace("\n", " ")
        log(f"    ✗ réponse non-ArcGrid : {head}")
        return None
    return txt


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


def encode(grid: list[list[int | None]]) -> list[int]:
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
                d = -v                      # élévation → sonde
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
                txt = fetch_grid(endpoint, cov)
                if not txt:
                    continue
                head, grid = parse_arcgrid(txt)
                agg, _, _ = aggregate(grid)
                rows, cols = len(agg), len(agg[0])
                sea = sum(1 for r in agg for v in r if v is not None and -v > 0)
                total = rows * cols
                if sea < total * 0.4:
                    log(f"    ✗ {sea}/{total} cases en mer — mauvaise couverture")
                    continue

                codes = encode(agg)
                flat = [v for r in agg for v in r]
                decode(codes, len(flat))        # ceinture et bretelles

                depths = [-v for r in agg for v in r if v is not None and -v > 0]
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

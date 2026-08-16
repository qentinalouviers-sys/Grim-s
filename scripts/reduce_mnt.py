#!/usr/bin/env python3
"""
reduce_mnt.py — un MNT bathymétrique téléchargé → la grille embarquée.

    python3 scripts/reduce_mnt.py MNT_ATL100m_HOMONIM_WGS84.asc

Produit : data/bathy-dieppe.json, lisible tel quel par js/data/bathy.js.

── POURQUOI CE SCRIPT EXISTE À CÔTÉ DE fetch_bathy.py ───────────────────────
fetch_bathy.py interroge un service en ligne. Quatre passages ont établi que le
WCS d'EMODnet ne sert pas le modèle de terrain mais un RENDU COLORIÉ sur huit
bits — des index de palette de 0 à 255, pas des mètres. Les garde-fous de ce
collecteur refusent cette donnée, et c'est le bon comportement : mieux vaut pas
de carte qu'une carte fausse.

La vraie donnée existe, mais elle se télécharge à la main, une fois, depuis un
portail. Ce script prend le relais à partir du fichier posé sur le disque. Il
n'a besoin d'AUCUNE dépendance — ni GDAL, ni numpy, ni rasterio — parce qu'un
job qui tourne une fois par an ne doit pas exiger deux cents mégaoctets de
bibliothèques système pour être rejoué dans trois ans.

── OÙ PRENDRE LE FICHIER ────────────────────────────────────────────────────
Deux sources, toutes deux gratuites et en licence ouverte.

1. SHOM — « MNT bathymétrique de façade Atlantique » (projet HOMONIM).
   Pas de 0,001°, soit environ 111 m. Couvre la mer du Nord, la Manche et le
   golfe de Gascogne. Format .asc disponible — du texte brut, donc lisible
   sans aucune bibliothèque, ce qui en fait le meilleur choix pour ce script.
   https://diffusion.shom.fr/mnt-facade-atl-homonim.html

2. EMODnet Bathymetry — portail de téléchargement, tuiles du DTM.
   1/16 de minute d'arc, soit environ 115 m. Formats NetCDF ou GeoTIFF ; ce
   script lit l'ASCII Grid et le GeoTIFF non compressé, pas le NetCDF.
   https://portal.emodnet-bathymetry.eu/

Les deux se valent en résolution. Le SHOM a l'avantage d'être la source
officielle française et de proposer du .asc.

── CE QUE CETTE RÉSOLUTION PERMET, ET CE QU'ELLE NE PERMET PAS ─────────────
À cent mètres de maille on lit le plateau côtier et sa cassure, les fosses, la
fosse du chenal, les grands bancs. On ne lit PAS le ridin isolé — deux à trois
mètres de haut, quelques centaines de mètres de longueur d'onde : il passe
entre les mailles. Pour celui-là il n'y a que le sondeur du bord, et l'app a un
carnet de sondes pour ça (js/fishing/soundings.js).

Le fichier produit porte cette limite dans ses métadonnées, et l'app l'affiche.

── FORMAT DE SORTIE ─────────────────────────────────────────────────────────
Miroir exact de decode() dans js/data/bathy.js : profondeurs entières en
mètres, différence d'une case à la suivante, encodée en RLE. Le fond de la
Manche est lisse — la plupart des différences valent zéro — et le fichier tombe
à quelques dizaines de kilo-octets pour cent mille cellules.

Deux sentinelles échappent à la chaîne des différences :
    32767  terre
    32766  pas de donnée
"""

from __future__ import annotations

import json
import math
import os
import struct
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "bathy-dieppe.json")

# Emprise embarquée : du Tréport à Fécamp, 30 milles au large. La même que la
# carte des fonds et que les épaves, pour que les trois couches se superposent
# exactement au lieu de se déborder de quelques minutes d'arc.
SOUTH, NORTH = 49.55, 50.25
WEST, EAST = 0.35, 1.85

# Maille visée pour la grille embarquée. 0,003° = 334 m en latitude, 214 m en
# longitude à 50°N. On agrège la source plutôt que de la rééchantillonner :
# moyenner trois mailles de 111 m est honnête, prétendre en fabriquer une de
# 50 m ne l'est pas.
TARGET_DLAT = 0.003
TARGET_DLON = 0.003

LAND = 32767
NODATA = 32766

# Garde-fou hérité de fetch_bathy.py, et il a déjà servi : le coin nord-ouest
# de l'emprise est à trente milles au large de Fécamp, donc sous 5 à 90 m
# d'eau. Toute grille qui prétend autre chose est refusée sans discussion.
SANITY_MIN_M, SANITY_MAX_M = 5, 90


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def die(msg: str, code: int = 1):
    log(f"✗ {msg}")
    sys.exit(code)


# ==========================================================================
# Lecture ASCII Grid (.asc / .txt)
# --------------------------------------------------------------------------
# Le format le plus simple qui soit : six lignes d'en-tête, puis les valeurs
# ligne par ligne, du NORD vers le sud. C'est celui que le SHOM propose, et
# c'est pour ça qu'on le préfère.
# ==========================================================================
def read_asc(path: str):
    header = {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        # L'en-tête fait six lignes, sauf quand il en fait cinq : `cellsize`
        # peut être remplacé par `dx`/`dy`, et l'origine être donnée en centre
        # de cellule (`xllcenter`) plutôt qu'en coin (`xllcorner`).
        keys = ("ncols", "nrows", "xllcorner", "yllcorner", "xllcenter",
                "yllcenter", "cellsize", "dx", "dy", "nodata_value")
        pos = f.tell()
        while True:
            line = f.readline()
            if not line:
                die("fichier .asc vide ou tronqué")
            first = line.split()[0].lower() if line.split() else ""
            if first not in keys:
                f.seek(pos)
                break
            parts = line.split()
            header[first] = float(parts[1])
            pos = f.tell()

        need = ("ncols", "nrows")
        for k in need:
            if k not in header:
                die(f"en-tête ASCII Grid incomplet : « {k} » manquant")

        ncols = int(header["ncols"])
        nrows = int(header["nrows"])
        dx = header.get("cellsize", header.get("dx"))
        dy = header.get("cellsize", header.get("dy", dx))
        if not dx:
            die("en-tête ASCII Grid sans cellsize ni dx")

        x0 = header.get("xllcorner", header.get("xllcenter"))
        y0 = header.get("yllcorner", header.get("yllcenter"))
        if x0 is None or y0 is None:
            die("en-tête ASCII Grid sans origine (xllcorner/xllcenter)")
        if "xllcenter" in header:
            x0 -= dx / 2
            y0 -= dy / 2

        nodata = header.get("nodata_value", -9999.0)

        # Lecture à plat : plus rapide et bien plus tolérant qu'un découpage
        # ligne par ligne. Certains producteurs coupent les lignes tous les
        # 1024 caractères sans respecter la structure du raster.
        vals = []
        for chunk in f:
            for tok in chunk.split():
                vals.append(float(tok))
        if len(vals) != ncols * nrows:
            die(f"{len(vals)} valeurs lues pour {ncols}×{nrows} = {ncols * nrows} attendues")

    return {
        "ncols": ncols, "nrows": nrows,
        "dx": dx, "dy": dy,
        "x0": x0, "y0": y0,
        "nodata": nodata,
        "vals": vals,   # du nord au sud, d'ouest en est
    }


# ==========================================================================
# Lecture GeoTIFF non compressé, bandes float32/float64/int16
# --------------------------------------------------------------------------
# Quatre-vingts lignes contre une dépendance système de deux cents mégaoctets.
# Ne gère volontairement que le cas simple : bande unique, non compressée, en
# tuiles de lignes (strips). C'est ce que produisent les portails.
# ==========================================================================
TIFF_TAGS = {
    256: "width", 257: "height", 258: "bits", 259: "compression",
    277: "samples", 339: "sample_format", 273: "strip_offsets",
    279: "strip_counts", 278: "rows_per_strip",
    33550: "pixel_scale", 33922: "tie_point", 42113: "nodata",
}


def read_tiff(path: str):
    raw = open(path, "rb").read()
    if len(raw) < 8:
        die("GeoTIFF trop court")
    endian = "<" if raw[:2] == b"II" else ">" if raw[:2] == b"MM" else None
    if not endian:
        die("ce n'est pas un TIFF (ni « II » ni « MM » en tête)")
    magic, ifd_off = struct.unpack(endian + "HI", raw[2:8])
    if magic != 42:
        die("BigTIFF non géré — redemande le fichier en TIFF classique ou en .asc")

    count = struct.unpack(endian + "H", raw[ifd_off:ifd_off + 2])[0]
    tags = {}
    SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
    FMT = {1: "B", 2: "c", 3: "H", 4: "I", 5: "II", 6: "b", 8: "h", 9: "i", 11: "f", 12: "d"}

    for i in range(count):
        off = ifd_off + 2 + i * 12
        tag, typ, n = struct.unpack(endian + "HHI", raw[off:off + 8])
        size = SIZES.get(typ, 1) * n
        if size <= 4:
            data = raw[off + 8:off + 8 + size]
        else:
            ptr = struct.unpack(endian + "I", raw[off + 8:off + 12])[0]
            data = raw[ptr:ptr + size]
        name = TIFF_TAGS.get(tag)
        if not name:
            continue
        if typ == 5:  # RATIONAL
            vs = struct.unpack(endian + f"{2 * n}I", data)
            tags[name] = [vs[k] / vs[k + 1] if vs[k + 1] else 0 for k in range(0, len(vs), 2)]
        elif typ == 2:
            tags[name] = data.rstrip(b"\x00").decode("ascii", "replace")
        else:
            tags[name] = list(struct.unpack(endian + FMT.get(typ, "B") * n, data))

    def one(name, default=None):
        v = tags.get(name, default)
        return v[0] if isinstance(v, list) and v else v

    width, height = int(one("width", 0)), int(one("height", 0))
    bits = int(one("bits", 0))
    comp = int(one("compression", 1))
    samples = int(one("samples", 1))
    sfmt = int(one("sample_format", 1))

    if comp != 1:
        die(f"GeoTIFF compressé (compression={comp}) — redemande-le non compressé, ou en .asc")
    if samples != 1:
        die(f"{samples} bandes : ce n'est pas un modèle de terrain mais une image")

    # LE garde-fou qui compte. Une bande de huit bits n'est JAMAIS un MNT : ce
    # sont des index de palette. C'est exactement ce que sert le WCS d'EMODnet,
    # et un passage précédent l'a pris pour des mètres — le fichier annonçait
    # 120 m de fond là où c'est l'altitude du plateau de Caux.
    if bits <= 8:
        die("bande de 8 bits : c'est un rendu colorié, pas un modèle de terrain. "
            "Reprends le fichier sur le portail de téléchargement, pas sur le WMS/WCS.")

    if sfmt == 3:
        code = {32: "f", 64: "d"}.get(bits)
    else:
        code = {16: "h", 32: "i"}.get(bits)
    if not code:
        die(f"échantillons {bits} bits format {sfmt} non gérés")

    scale = tags.get("pixel_scale") or []
    tie = tags.get("tie_point") or []
    if len(scale) < 2 or len(tie) < 6:
        die("GeoTIFF sans géoréférencement (pixel_scale / tie_point absents)")
    dx, dy = float(scale[0]), float(scale[1])
    # tie_point = (i, j, k, X, Y, Z) : le pixel (i,j) vaut (X,Y).
    x_ul = float(tie[3]) - float(tie[0]) * dx
    y_ul = float(tie[4]) + float(tie[1]) * dy

    offsets = tags.get("strip_offsets") or []
    counts = tags.get("strip_counts") or []
    rps = int(one("rows_per_strip", height))
    px = bits // 8

    vals = []
    for k, off in enumerate(offsets):
        n = counts[k] // px if k < len(counts) else 0
        vals.extend(struct.unpack(endian + code * n, raw[off:off + counts[k]]))
    vals = vals[:width * height]
    if len(vals) != width * height:
        die(f"{len(vals)} pixels lus pour {width}×{height} attendus")

    nod = one("nodata")
    try:
        nodata = float(nod)
    except (TypeError, ValueError):
        nodata = -9999.0

    return {
        "ncols": width, "nrows": height,
        "dx": dx, "dy": dy,
        # Le .asc porte le coin INFÉRIEUR gauche, le TIFF le coin SUPÉRIEUR :
        # on ramène tout à la convention du .asc.
        "x0": x_ul, "y0": y_ul - height * dy,
        "nodata": nodata,
        "vals": [float(v) for v in vals],
    }


# ==========================================================================
# Agrégation sur l'emprise embarquée
# ==========================================================================
def build(src):
    dx, dy = src["dx"], src["dy"]
    if dx > 0.02:
        die(f"maille source de {dx:.4f}° — trop grossière, ce n'est pas un MNT côtier")

    # Combien de cases source par case de sortie, au moins une.
    fx = max(1, round(TARGET_DLON / dx))
    fy = max(1, round(TARGET_DLAT / dy))
    d_lon = dx * fx
    d_lat = dy * fy
    log(f"  source {src['ncols']}×{src['nrows']} à {dx:.5f}° — agrégation {fx}×{fy} → {d_lon:.4f}°")

    cols = int(math.floor((EAST - WEST) / d_lon))
    rows = int(math.floor((NORTH - SOUTH) / d_lat))
    if cols < 10 or rows < 10:
        die("l'emprise demandée ne tombe pas dans le fichier fourni")

    def src_at(i_src, j_src):
        """Valeur source, ou None. i depuis le NORD, j depuis l'ouest."""
        if i_src < 0 or j_src < 0 or i_src >= src["nrows"] or j_src >= src["ncols"]:
            return None
        v = src["vals"][i_src * src["ncols"] + j_src]
        if v == src["nodata"] or not math.isfinite(v):
            return None
        return v

    cells = []
    positives = 0
    # Ligne 0 = LE SUD. C'est la convention du décodeur — `i = (lat − south) /
    # dLat` — et pas celle du fichier source, qui va du nord au sud comme
    # toutes les grilles ASCII. Inverser ici plutôt que dans le décodeur : le
    # décodeur est déjà embarqué et testé, c'est le producteur qui s'aligne.
    for i in range(rows):
        lat = SOUTH + (i + 0.5) * d_lat
        for j in range(cols):
            lon = WEST + (j + 0.5) * d_lon
            # Fenêtre source correspondante.
            j0 = int(round((lon - src["x0"]) / dx - fx / 2))
            i0 = int(round((src["y0"] + src["nrows"] * dy - lat) / dy - fy / 2))

            acc = []
            for a in range(fy):
                for b in range(fx):
                    v = src_at(i0 + a, j0 + b)
                    if v is not None:
                        acc.append(v)
            if not acc:
                cells.append(NODATA)
                continue
            mean = sum(acc) / len(acc)
            # Convention des MNT : l'altitude est positive vers le haut, donc
            # la mer est NÉGATIVE. La profondeur est l'opposé. Un fichier livré
            # déjà en profondeurs positives se repère au signe dominant, et on
            # le retourne plutôt que de rendre une carte de montagnes.
            depth = -mean
            if depth < 0:
                positives += 1
            cells.append(int(round(depth)))

    # Si l'immense majorité des cases est « négative en profondeur », c'est que
    # le fichier donnait déjà des profondeurs positives : on inverse tout.
    water = [c for c in cells if c not in (LAND, NODATA)]
    if water and positives > 0.7 * len(water):
        log("  ⚠ profondeurs déjà positives dans la source — inversion du signe")
        cells = [c if c in (LAND, NODATA) else -c for c in cells]

    # La terre est marquée plutôt que rendue comme une profondeur négative :
    # l'app la dessine différemment et ne la propose jamais comme un poste.
    cells = [LAND if (c not in (LAND, NODATA) and c <= 0) else c for c in cells]

    sea = [c for c in cells if c not in (LAND, NODATA)]
    if not sea:
        die("aucune cellule de mer dans l'emprise — mauvais fichier ou mauvaise zone")

    # Le contrôle de vraisemblance : le coin nord-ouest est au large.
    # Coin nord-ouest : ligne du HAUT (donc i grand, puisque 0 est le sud).
    nw = cells[int(rows * 0.95) * cols + int(cols * 0.05)]
    if nw in (LAND, NODATA) or not (SANITY_MIN_M <= nw <= SANITY_MAX_M):
        die(f"le coin nord-ouest annonce {nw} m — il est à 30 milles au large de Fécamp, "
            f"donc entre {SANITY_MIN_M} et {SANITY_MAX_M} m. Grille refusée.")

    log(f"  mer : {len(sea)} cellules, {min(sea)} à {max(sea)} m, "
        f"médiane {sorted(sea)[len(sea) // 2]} m")

    # Les noms de champs sont ceux que decode() lit dans js/data/bathy.js, à la
    # lettre près. Le décodeur est embarqué et testé : c'est lui qui fait foi,
    # et le producteur qui s'y plie.
    return {
        "size": [rows, cols],
        "grid": encode(cells),
        "bbox": [SOUTH, WEST, NORTH, EAST],
        "step": [d_lat, d_lon],
        "source": SOURCE_NAME,
        "coverage": "MNT bathymétrique agrégé",
        "licence": "Licence ouverte / CC-BY selon la source",
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "resolutionM": int(round(d_lat * 111320)),
        "depthRangeM": [min(sea), max(sea)],
        "note": ("Modèle public agrégé. À cette maille on lit le plateau, sa cassure, "
                 "les fosses et les grands bancs — pas le ridin isolé, qui passe entre "
                 "les mailles. Le sondeur du bord reste le juge."),
    }


def encode(cells):
    """
    Miroir exact de decode() dans js/data/bathy.js.

    Le décodeur lit une liste PLATE de couples : codes[i] est une différence,
    codes[i+1] son nombre de répétitions, et il applique `prev += d` À CHAQUE
    répétition. Une pente régulière se code donc [d, n] et un plat [0, n] —
    ce n'est pas un RLE sur les valeurs mais sur les DIFFÉRENCES, et confondre
    les deux produit un fichier qui se décode en silence sur des profondeurs
    absurdes.

    Les sentinelles (≥ 30000) échappent à la chaîne : le décodeur les recopie
    sans toucher à `prev`, donc l'encodeur ne doit pas les compter non plus.
    """
    out = []
    prev = 0
    i = 0
    n = len(cells)
    while i < n:
        c = cells[i]
        if c in (LAND, NODATA):
            run = 1
            while i + run < n and cells[i + run] == c:
                run += 1
            out.append(c)
            out.append(run)
            i += run
            continue
        d = c - prev
        prev = c
        run = 1
        # Tant que la case suivante poursuit la même différence.
        while (i + run < n and cells[i + run] not in (LAND, NODATA)
               and cells[i + run] - prev == d):
            prev = cells[i + run]
            run += 1
        out.append(d)
        out.append(run)
        i += run
    return out


SOURCE_NAME = "inconnue"


def main():
    global SOURCE_NAME
    if len(sys.argv) < 2:
        print(__doc__)
        die("donne le chemin du fichier téléchargé (.asc ou .tif)", 2)

    path = sys.argv[1]
    if not os.path.exists(path):
        die(f"fichier introuvable : {path}")

    SOURCE_NAME = os.path.basename(path)
    ext = os.path.splitext(path)[1].lower()
    log(f"→ lecture de {SOURCE_NAME} ({os.path.getsize(path) / 1e6:.1f} Mo)")

    if ext in (".asc", ".txt", ".grd"):
        src = read_asc(path)
    elif ext in (".tif", ".tiff"):
        src = read_tiff(path)
    else:
        die(f"extension « {ext} » non gérée. Attendu : .asc, .txt, .tif")

    spec = build(src)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(spec, f, separators=(",", ":"))
    size = os.path.getsize(OUT)
    log(f"✓ {OUT} — {spec['size'][0]}×{spec['size'][1]} cellules, {size / 1024:.0f} ko")
    log("  Ajoute-le à sw.js (liste SHELL) pour qu'il soit disponible hors ligne.")


if __name__ == "__main__":
    main()

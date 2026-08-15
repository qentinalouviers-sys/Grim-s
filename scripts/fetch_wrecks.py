#!/usr/bin/env python3
"""
fetch_wrecks.py — épaves du secteur de Dieppe, depuis EMODnet Human Activities.

Produit : data/wrecks-dieppe.json

── POURQUOI ─────────────────────────────────────────────────────────────────
Les huit secteurs types livrés avec l'app sont des ARCHÉTYPES d'habitat que
j'ai positionnés approximativement : ils portent une logique de pêche, pas une
marque. C'est assumé et écrit dans le fichier — mais ça ne remplace pas un
point réel.

Une épave, elle, est un point réel, public, et documenté : c'est un obstacle
à la navigation, donc l'État le relève et le publie. EMODnet Human Activities
agrège ces relevés ; pour la France la source est le SHOM. Une épave dans
20–40 m d'eau en Manche orientale, c'est le poste à bar et à lieu jaune par
excellence — du relief dur au milieu du sable, un abri dans le courant, et du
fourrage qui tourne autour.

── HONNÊTETÉ DE LA DONNÉE ───────────────────────────────────────────────────
Ces positions sont celles du relevé hydrographique, pas celles d'un sondeur de
pêche : selon l'ancienneté de la levée, l'écart peut atteindre plusieurs
dizaines de mètres, et certaines entrées sont des obstructions douteuses qui
n'ont jamais été confirmées. L'app affiche la précision annoncée quand elle
existe, et ne prétend jamais mieux.

On ne garde QUE ce qui est pêchable depuis Dieppe et sous une sonde plausible :
inutile d'embarquer les épaves du rail montant à 30 milles.
"""

from __future__ import annotations
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "wrecks-dieppe.json")

SOUTH, NORTH = 49.55, 50.25
WEST, EAST = 0.35, 1.85

PORT = (49.9319, 1.0847)
MAX_NM = 26.0          # au-delà, ce n'est plus une sortie à la journée

TIMEOUT = 120
UA = "Grim-s-Compagnon/1.0 (+https://github.com/qentinalouviers-sys/Grim-s)"

ENDPOINTS = [
    "https://ows.emodnet-humanactivities.eu/wfs",
    "https://ows.emodnet-humanactivities.eu/geoserver/wfs",
    "https://ows.emodnet-humanactivities.eu/geoserver/emodnet/wfs",
]

LAYER_HINTS = [("wreck", 10), ("shipwreck", 10), ("cultural_heritage", 4)]
LAYER_VETO = ("density", "grid", "aggregat")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url: str, timeout: int = TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def haversine_nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import radians, sin, cos, asin, sqrt
    la1, lo1, la2, lo2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((la2 - la1) / 2) ** 2 + cos(la1) * cos(la2) * sin((lo2 - lo1) / 2) ** 2
    return 2 * 3440.065 * asin(sqrt(h))


def discover(endpoint: str) -> list[str]:
    url = f"{endpoint}?service=WFS&version=2.0.0&request=GetCapabilities"
    xml = get(url, timeout=90).decode("utf-8", "replace")
    names = re.findall(r"<(?:\w+:)?Name>([^<]+)</(?:\w+:)?Name>", xml)
    seen, out = set(), []
    for n in names:
        n = n.strip()
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def rank(name: str) -> int:
    low = name.lower()
    if any(v in low for v in LAYER_VETO):
        return -1
    return max((w for h, w in LAYER_HINTS if h in low), default=0)


# L'ordre des axes de l'EPSG:4326 est le piège classique du WFS, et il a coûté
# un passage complet : « EPSG:4326 » vaut latitude d'abord dans la norme, mais
# GeoServer sert historiquement longitude d'abord sous ce nom court, et
# latitude d'abord sous l'URN. Une emprise lue à l'envers place le rectangle au
# large de la Somalie — le service répond poliment zéro entité, sans erreur.
# On essaie donc les trois écritures et on garde celle qui rapporte.
BBOX_FORMS = [
    ("urn:ogc:def:crs:EPSG::4326", "{s},{w},{n},{e}", "lat d’abord (URN)"),
    ("EPSG:4326", "{w},{s},{e},{n}", "lon d’abord (nom court)"),
    ("EPSG:4326", "{s},{w},{n},{e}", "lat d’abord (nom court)"),
]


def fetch_features(endpoint: str, layer: str) -> list[dict]:
    best: list[dict] = []
    for crs, tpl, label in BBOX_FORMS:
        box = tpl.format(s=SOUTH, w=WEST, n=NORTH, e=EAST)
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": layer,
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "bbox": f"{box},{crs}",
            "count": "4000",
        }
        url = f"{endpoint}?{urllib.parse.urlencode(params)}"
        try:
            data = json.loads(get(url).decode("utf-8", "replace"))
        except Exception as e:                                  # noqa: BLE001
            log(f"      ✗ emprise {label} : {e}")
            continue
        feats = data.get("features", [])
        log(f"      emprise {label} : {len(feats)} entités")
        if len(feats) > len(best):
            best = feats
        if best:
            break
    return best


# Les schémas EMODnet changent de casse et de nom d'un millésime à l'autre :
# on cherche par intention plutôt que par clé exacte.
# Les jeux hydrographiques ne laissent presque jamais un champ vide : ils
# écrivent « n/a », « unknown », « - ». Un premier passage a donc annoncé
# « 189 nommées » alors que 188 s'appelaient n/a.
BLANK = {"", "-", "--", "n/a", "na", "null", "unknown", "unnamed", "none", "0", "nan"}


def pick(props: dict, *needles: str):
    for k, v in props.items():
        kl = k.lower()
        if not any(n in kl for n in needles):
            continue
        if v is None:
            continue
        if str(v).strip().lower() in BLANK:
            continue
        return v
    return None


def point_of(geom: dict) -> tuple[float, float] | None:
    """Un point représentatif, quelle que soit la géométrie livrée."""
    if not geom:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Point":
        return (c[1], c[0])
    # Certaines entrées sont des multipoints ou de petits polygones d'emprise :
    # le centroïde grossier suffit, on ne navigue pas au mètre là-dessus.
    pts: list[list[float]] = []

    def walk(x):
        if isinstance(x, list) and x and isinstance(x[0], (int, float)):
            pts.append(x)
        elif isinstance(x, list):
            for y in x:
                walk(y)

    walk(c)
    if not pts:
        return None
    return (sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts))


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
        log(f"  {len(names)} couches, {len(ranked)} candidates : "
            + ", ".join(n for _, n in ranked[:6]))
        for score, layer in ranked[:5]:
            log(f"  · essai {layer} (score {score})")
            try:
                feats = fetch_features(endpoint, layer)
            except Exception as e:                              # noqa: BLE001
                log(f"    ✗ {e}")
                report.append(f"{layer} : {e}")
                continue
            log(f"    {len(feats)} entités dans l'emprise")
            if not feats:
                continue

            wrecks, seen = [], set()
            for f in feats:
                p = point_of(f.get("geometry") or {})
                if not p:
                    continue
                lat, lon = p
                if not (SOUTH <= lat <= NORTH and WEST <= lon <= EAST):
                    continue
                d = haversine_nm(PORT, (lat, lon))
                if d > MAX_NM:
                    continue
                # Le même naufrage figure souvent deux fois, relevé par deux
                # services : on dédoublonne à 60 m, sous la précision annoncée.
                key = (round(lat, 3), round(lon, 3))
                if key in seen:
                    continue
                seen.add(key)

                props = f.get("properties") or {}
                name = pick(props, "name", "vessel", "shipname", "title")
                depth = pick(props, "depth", "sounding", "wdepth")
                year = pick(props, "year", "sunk", "loss", "date")
                try:
                    depth = round(float(depth), 1) if depth is not None else None
                except (TypeError, ValueError):
                    depth = None
                if depth is not None and not (0 < depth < 120):
                    depth = None

                w = {
                    "lat": round(lat, 5),
                    "lon": round(lon, 5),
                    "distNM": round(d, 1),
                }
                if name:
                    w["name"] = str(name)[:60]
                if depth is not None:
                    w["depthM"] = depth
                if year:
                    ys = str(year)
                    m = re.match(r"(1[89]\d\d|20\d\d)", ys)
                    if m:
                        w["year"] = m.group(1)
                wrecks.append(w)

            if len(wrecks) < 3:
                log(f"    ✗ {len(wrecks)} épaves retenues — trop peu, on continue")
                continue

            wrecks.sort(key=lambda w: w["distNM"])
            doc = {
                "_comment": [
                    "Épaves et obstructions relevées dans le secteur de Dieppe.",
                    "Source : EMODnet Human Activities (pour la France : SHOM).",
                    "",
                    "Ce sont des positions HYDROGRAPHIQUES, pas des marques de pêche :",
                    "selon l'ancienneté de la levée l'écart peut atteindre plusieurs",
                    "dizaines de mètres, et certaines entrées sont des obstructions",
                    "douteuses jamais confirmées. Arrive dessus au sondeur.",
                    "",
                    "depthM : sonde annoncée au-dessus de l'obstacle quand elle existe.",
                    "distNM : distance au port de Dieppe.",
                ],
                "source": "EMODnet Human Activities",
                "layer": layer,
                "endpoint": endpoint,
                "licence": "CC-BY 4.0 — EMODnet Human Activities",
                "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "port": {"lat": PORT[0], "lon": PORT[1]},
                "maxDistNM": MAX_NM,
                "count": len(wrecks),
                "wrecks": wrecks,
            }
            os.makedirs(os.path.dirname(OUT), exist_ok=True)
            with open(OUT, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, indent=1)
            named = sum(1 for w in wrecks if "name" in w)
            sounded = sum(1 for w in wrecks if "depthM" in w)
            log(f"    ✓ {len(wrecks)} épaves ({named} nommées, {sounded} sondées), "
                f"{os.path.getsize(OUT) // 1024} kio")
            return 0

    log("\nAucune couche exploitable. Vu :")
    for line in report[:20]:
        log(f"  · {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

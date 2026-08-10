#!/usr/bin/env python3
"""
refresh_tide.py — récupère la marée officielle SHOM pour Dieppe.

Produit :
    data/tide-dieppe.json     courbe + pleines/basses mers de la fenêtre courante
    data/tide-history.json    archive glissante, alimente scripts/fit_harmonics.py

── POURQUOI UNE ARCHIVE ─────────────────────────────────────────────────────
Sept jours de données ne permettent pas de séparer S2 de K2 (il faut ~182 jours)
ni K1 de P1 (~183 jours). En accumulant chaque passage dans une archive
glissante, l'ajustement harmonique gagne en résolution mois après mois : au
bout d'un an, le modèle embarqué prédit la marée aussi bien que l'annuaire,
définitivement et hors ligne. L'archive est sous-échantillonnée à 30 min pour
rester sous ~400 ko à un an.

── ROBUSTESSE ───────────────────────────────────────────────────────────────
Le format de la vignette SHOM n'est pas un contrat d'API : il peut changer sans
préavis. Le script essaie plusieurs points d'entrée et plusieurs formes de
charge utile, et sort en code 0 avec un avertissement s'il n'obtient rien —
l'application continue de fonctionner sur son modèle harmonique. Faire échouer
un déploiement parce qu'un site tiers a changé une balise serait absurde.
"""

from __future__ import annotations
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta, date

try:  # zoneinfo est standard depuis 3.9 ; on dégrade proprement s'il manque
    from zoneinfo import ZoneInfo
    PARIS = ZoneInfo("Europe/Paris")
except Exception:  # noqa: BLE001
    PARIS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "tide-dieppe.json")
HISTORY = os.path.join(ROOT, "data", "tide-history.json")

HARBOUR = "DIEPPE"
HISTORY_DAYS = 400
HISTORY_STEP_MS = 30 * 60 * 1000

ENDPOINTS = [
    f"https://services.data.shom.fr/hdm/vignette/grande/{HARBOUR}",
    f"https://services.data.shom.fr/hdm/vignette/petite/{HARBOUR}",
]

UA = {
    "User-Agent": "grims-compagnon/1.0 (+https://github.com/) tide-refresh",
    "Accept": "text/html,application/json;q=0.9,*/*;q=0.5",
}


def fetch(url: str, timeout: int = 25, attempts: int = 3) -> tuple[str | None, dict]:
    """
    @returns (texte, métadonnées) — les métadonnées servent au diagnostic.

    Le service SHOM est intermittent : observé en CI, il répond correctement
    puis reste muet au passage suivant, surtout après plusieurs appels
    rapprochés. Trois tentatives espacées suffisent à absorber ça. Un
    rafraîchissement raté n'est pas grave en soi — l'archive attend le
    passage d'après — mais autant ne pas perdre une journée pour un hoquet.
    """
    meta = {"url": url}
    for attempt in range(attempts):
        text, meta = _fetch_once(url, timeout)
        if text:
            if attempt:
                print(f"    (obtenu à la tentative {attempt + 1})")
            return text, meta
        if attempt < attempts - 1:
            time.sleep(3 * (attempt + 1))
    return None, meta


def _fetch_once(url: str, timeout: int) -> tuple[str | None, dict]:
    meta = {"url": url}
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            meta["status"] = r.status
            meta["contentType"] = r.headers.get("Content-Type", "?")
            meta["finalUrl"] = r.url
        meta["bytes"] = len(raw)
        for enc in ("utf-8", "latin-1"):
            try:
                return raw.decode(enc), meta
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", "replace"), meta
    except Exception as e:  # noqa: BLE001 — on veut vraiment tout attraper
        meta["error"] = f"{type(e).__name__}: {e}"
        print(f"  ✗ {url} → {meta['error']}", file=sys.stderr)
        return None, meta


def diagnose(text: str, meta: dict) -> None:
    """
    Quand le parsing échoue, on ne peut rien deviner d'un « aucune donnée » sec.
    Le format de la vignette SHOM n'est pas un contrat d'API et peut changer :
    on imprime de quoi le ré-adapter sans avoir à reproduire l'appel à la main.
    Aucune donnée personnelle n'est en jeu — c'est une page publique.
    """
    print(f"  ── diagnostic {meta.get('url')}", file=sys.stderr)
    print(f"     statut {meta.get('status')} · {meta.get('contentType')} · "
          f"{meta.get('bytes')} octets", file=sys.stderr)
    if meta.get("finalUrl") and meta["finalUrl"] != meta.get("url"):
        print(f"     redirigé vers {meta['finalUrl']}", file=sys.stderr)
    if not text:
        return

    # Marqueurs utiles : où se cache la donnée ?
    for marker in ("iframe", "<script", "var ", "JSON", "hauteur", "coef",
                   "pleine", "basse", "[[", "data-", "canvas", "svg"):
        n = text.lower().count(marker.lower())
        if n:
            print(f"     « {marker} » × {n}", file=sys.stderr)

    # Premiers nombres flottants groupés : la signature d'une courbe encodée.
    runs = re.findall(r"(?:-?\d+\.\d+\s*,\s*){5,}-?\d+\.\d+", text)
    print(f"     séries de flottants détectées : {len(runs)}", file=sys.stderr)
    if runs:
        print(f"     plus longue : {len(runs[0].split(','))} valeurs — "
              f"{runs[0][:120]}…", file=sys.stderr)

    clean = re.sub(r"\s+", " ", text[:1200])
    print(f"     début : {clean}", file=sys.stderr)


# ═══════════════════════════════════════════════════════════════════════════
# Extraction
# ═══════════════════════════════════════════════════════════════════════════

TIME_RE = r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?"

MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5,
    "juin": 6, "juillet": 7, "août": 8, "aout": 8, "septembre": 9,
    "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}


def unwrap_vignette(js: str) -> str:
    """
    La vignette SHOM n'est pas une page : c'est un SCRIPT qui fabrique une
    iframe puis y écrit le HTML ligne par ligne en document.write('…'), avec
    les guillemets échappés. Chercher la donnée directement dans ce JS ne
    donne rien — il faut d'abord rejouer les écritures pour reconstituer le
    document. C'est exactement ce qui faisait échouer le parsing.
    """
    parts = re.findall(r"document\.write\(\s*'((?:\\.|[^'\\])*)'\s*\)", js)
    parts += re.findall(r'document\.write\(\s*"((?:\\.|[^"\\])*)"\s*\)', js)
    html = "".join(parts)
    for a, b in (('\\"', '"'), ("\\'", "'"), ("\\/", "/"), ("\\n", "\n"), ("\\t", "\t")):
        html = html.replace(a, b)
    return html


def strip_tags(html: str) -> str:
    """HTML → texte, en gardant les séparations de cellules et de lignes."""
    txt = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    txt = re.sub(r"(?i)</(tr|div|p|li|h\d)>", "\n", txt)
    txt = re.sub(r"(?i)</(td|th|span)>", " | ", txt)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = (txt.replace("&nbsp;", " ").replace("&#39;", "'")
              .replace("&amp;", "&").replace("&eacute;", "é").replace("&egrave;", "è"))
    return re.sub(r"[ \t]+", " ", txt)


def parse_vignette_text(text: str, now: datetime) -> list[dict]:
    """
    Lit la table PM/BM du texte reconstitué. Le SHOM la présente par journée :
    un intitulé de date, puis des lignes « PM 04h35 8.42 m » et un coefficient.

    Les heures sont sans date ; on les rattache au jour courant de la lecture.
    Le SHOM affiche l'heure LÉGALE française, pas UTC : on convertit via la
    zone Europe/Paris, sinon tout glisse d'une ou deux heures selon la saison —
    l'erreur exacte qui rendrait le carnet de marée inutilisable.
    """
    out: list[dict] = []
    current: date | None = None
    utc_offset_h: float | None = None

    # « (Heure UTC) » ou « (Heure légale) » : le SHOM le précise en en-tête.
    if re.search(r"heure\s*(?:utc|tu)\b", text, re.I):
        utc_offset_h = 0.0

    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue

        # Intitulé de jour : « lundi 10 août 2026 », « 10/08/2026 », « 10 août »
        m = re.search(r"(\d{1,2})\s+(" + "|".join(MONTHS) + r")\s*(\d{4})?", line, re.I)
        if m:
            year = int(m.group(3)) if m.group(3) else now.year
            try:
                current = date(year, MONTHS[m.group(2).lower()], int(m.group(1)))
            except ValueError:
                pass
        else:
            m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b", line)
            if m:
                y = int(m.group(3))
                y += 2000 if y < 100 else 0
                try:
                    current = date(y, int(m.group(2)), int(m.group(1)))
                except ValueError:
                    pass

        # Ligne de marée : un type, une heure, une hauteur, parfois un coefficient.
        row = re.search(
            r"(PM|BM|pleine\s*mer|basse\s*mer)\D{0,12}?(\d{1,2})\s*[h:]\s*(\d{2})"
            r"\D{0,12}?(\d{1,2}[.,]\d{1,2})\s*m?"
            r"(?:\D{0,12}?(\d{2,3})\b)?",
            line, re.I,
        )
        if not row or current is None:
            continue

        kind = "HW" if row.group(1).lower().startswith(("pm", "pleine")) else "LW"
        hh, mm = int(row.group(2)), int(row.group(3))
        if hh > 23 or mm > 59:
            continue
        height = float(row.group(4).replace(",", "."))
        if not (-2 <= height <= 15):
            continue

        naive = datetime(current.year, current.month, current.day, hh, mm)
        if utc_offset_h == 0.0:
            stamp = naive.replace(tzinfo=timezone.utc)
        else:
            stamp = naive.replace(tzinfo=PARIS) if PARIS else naive.replace(tzinfo=timezone.utc)

        e = {"t": int(stamp.timestamp() * 1000), "h": round(height, 3), "kind": kind}
        coef = row.group(5)
        if coef and 20 <= int(coef) <= 130:
            e["coefficient"] = int(coef)
        out.append(e)

    return dedupe(out)


def parse_curve(text: str, day_hint: datetime) -> list[dict]:
    """
    Extrait une courbe (t, hauteur). Trois formes gérées, dans l'ordre :
      1. paires ["2026-08-10 04:35", 7.23]
      2. tableau JSON de hauteurs seules, pas régulier déduit du nombre de points
      3. paires (minutes_depuis_minuit, hauteur)
    """
    # Forme 1 — la plus explicite
    pairs = re.findall(rf'"({TIME_RE})"\s*,\s*"?(-?\d+(?:\.\d+)?)"?', text)
    if len(pairs) > 20:
        out = []
        for ts, h in pairs:
            ms = to_ms(ts)
            if ms:
                out.append({"t": ms, "h": round(float(h), 3)})
        if len(out) > 20:
            return dedupe(out)

    # Forme 2 — long tableau de flottants (la vignette encode souvent 288 points/jour)
    for m in re.finditer(r"\[\s*((?:-?\d+\.\d+\s*,\s*){50,}-?\d+\.\d+)\s*\]", text):
        vals = [float(v) for v in m.group(1).split(",")]
        if not (100 <= len(vals) <= 4000):
            continue
        if not all(-2 <= v <= 15 for v in vals):
            continue  # ce ne sont pas des hauteurs d'eau
        days = max(1, round(len(vals) / 288))
        step = days * 86_400_000 / len(vals)
        base = int(day_hint.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        return [{"t": int(base + i * step), "h": round(v, 3)} for i, v in enumerate(vals)]

    return []


def parse_extrema(text: str) -> list[dict]:
    """Table des pleines et basses mers, avec coefficient s'il est présent."""
    out = []
    # « PM 04:35 8.42 95 » / « pleine mer;2026-08-10 04:35;8.42;95 »
    for m in re.finditer(
        rf'(PM|BM|pleine[ _]?mer|basse[ _]?mer|high|low)\D{{0,12}}({TIME_RE}|\d{{1,2}}[:h]\d{{2}})'
        rf'\D{{0,8}}(-?\d+[.,]\d+)(?:\D{{0,8}}(\d{{2,3}}))?',
        text, re.I,
    ):
        kind_raw, ts, height, coef = m.groups()
        kind = "HW" if kind_raw.lower().startswith(("pm", "pleine", "high")) else "LW"
        ms = to_ms(ts)
        if not ms:
            continue
        e = {"t": ms, "h": round(float(height.replace(",", ".")), 3), "kind": kind}
        if coef and 20 <= int(coef) <= 130:
            e["coefficient"] = int(coef)
        out.append(e)
    return dedupe(out)


def to_ms(ts: str) -> int | None:
    ts = ts.strip().replace("h", ":")
    try:
        if re.fullmatch(r"\d{1,2}:\d{2}", ts):
            return None  # heure seule, sans date : inexploitable de façon fiable
        d = datetime.fromisoformat(ts.replace(" ", "T"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    except ValueError:
        return None


def dedupe(items: list[dict]) -> list[dict]:
    seen = {}
    for it in items:
        seen[it["t"]] = it
    return [seen[k] for k in sorted(seen)]


# ═══════════════════════════════════════════════════════════════════════════
# Archive
# ═══════════════════════════════════════════════════════════════════════════

def merge_history(curve: list[dict], extrema: list[dict] | None = None) -> list[dict]:
    hist = []
    if os.path.exists(HISTORY):
        try:
            with open(HISTORY, encoding="utf-8") as f:
                hist = json.load(f).get("curve", [])
        except Exception as e:  # noqa: BLE001
            print(f"  ! archive illisible, on repart de zéro ({e})", file=sys.stderr)

    merged = {p["t"]: p for p in hist}

    # Les PM/BM sont des observations (t, hauteur) à part entière, et les plus
    # informatives qui soient pour un ajustement harmonique : elles portent
    # l'amplitude ET la phase. Quand le SHOM ne publie pas de courbe — c'est le
    # cas de la vignette — elles constituent à elles seules la série d'entrée.
    # On les garde à leur horodatage exact, sans arrondi.
    for e in extrema or []:
        merged[e["t"]] = {"t": e["t"], "h": e["h"], "x": 1}

    for p in curve:
        if p["t"] % HISTORY_STEP_MS < 60_000 or p["t"] % HISTORY_STEP_MS > HISTORY_STEP_MS - 60_000:
            merged[p["t"] - p["t"] % HISTORY_STEP_MS] = {
                "t": p["t"] - p["t"] % HISTORY_STEP_MS, "h": p["h"]
            }

    cutoff = int((datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)).timestamp() * 1000)
    return [merged[k] for k in sorted(merged) if k >= cutoff]


# ═══════════════════════════════════════════════════════════════════════════

def main() -> int:
    now = datetime.now(timezone.utc)
    print(f"↻ Marée SHOM — {HARBOUR} — {now.isoformat(timespec='seconds')}")

    curve: list[dict] = []
    extrema: list[dict] = []
    used = None

    diagnostics = []
    for url in ENDPOINTS:
        print(f"  → {url}")
        text, meta = fetch(url)
        if not text:
            diagnostics.append((None, meta))
            continue

        # La charge utile est un script qui écrit une iframe : on reconstitue
        # le document avant toute tentative de lecture.
        html = unwrap_vignette(text)
        plain = strip_tags(html) if html else ""
        meta["unwrappedBytes"] = len(html)

        curve = parse_curve(text, now)
        extrema = parse_extrema(text) or parse_vignette_text(plain, now)
        print(f"    {len(html)} octets reconstitués · "
              f"{len(curve)} points de courbe, {len(extrema)} extrema")
        if curve or extrema:
            used = url
            break
        meta["plain"] = plain
        diagnostics.append((text, meta))

    if not curve and not extrema:
        print("  ✗ Aucune donnée exploitable.", file=sys.stderr)
        for text, meta in diagnostics:
            diagnose(text, meta)
        print("    L'application reste fonctionnelle sur son modèle harmonique embarqué.",
              file=sys.stderr)
        print("    Si le format SHOM a changé, adapter parse_curve()/parse_extrema().",
              file=sys.stderr)
        return 0  # volontairement non bloquant

    payload = {
        "_comment": "Généré par scripts/refresh_tide.py — ne pas éditer à la main.",
        "port": "Dieppe",
        "source": used,
        "fetchedAt": int(now.timestamp() * 1000),
        "fetchedAtISO": now.isoformat(timespec="seconds"),
        "datum": "ZH (zéro hydrographique SHOM)",
        "curve": curve,
        "extrema": extrema,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  ✓ {OUT} — {len(curve)} points, {len(extrema)} extrema")

    if curve or extrema:
        hist = merge_history(curve, extrema)
        with open(HISTORY, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "_comment": "Archive glissante pour scripts/fit_harmonics.py. "
                                f"Pas {HISTORY_STEP_MS // 60000} min, {HISTORY_DAYS} jours max.",
                    "port": "Dieppe",
                    "updatedAt": now.isoformat(timespec="seconds"),
                    "curve": hist,
                },
                f, ensure_ascii=False, separators=(",", ":"),
            )
        span = (hist[-1]["t"] - hist[0]["t"]) / 86_400_000 if len(hist) > 1 else 0
        n_ext = sum(1 for p in hist if p.get("x"))
        print(f"  ✓ {HISTORY} — {len(hist)} points dont {n_ext} PM/BM, "
              f"{span:.0f} jours d'historique")

    return 0


if __name__ == "__main__":
    sys.exit(main())

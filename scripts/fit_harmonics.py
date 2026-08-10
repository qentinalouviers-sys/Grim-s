#!/usr/bin/env python3
"""
fit_harmonics.py — ajuste les constantes harmoniques de Dieppe sur la donnée réelle.

    entrée  : data/tide-history.json (ou data/tide-dieppe.json à défaut)
    sortie  : data/harmonics-dieppe.json

C'est ce script qui transforme l'application : tant qu'il n'a pas tourné, la
marée embarquée repose sur des phases estimées (±30 min). Après un passage sur
une semaine, elle est bonne à quelques centimètres. Après un an d'archive, elle
vaut l'annuaire — pour toujours, et hors ligne.

── MÉTHODE ──────────────────────────────────────────────────────────────────
Le modèle est LINÉAIRE en ses inconnues si on écrit chaque constituant sous la
forme  a·cos(θ) + b·sin(θ)  au lieu de  A·cos(θ − g) :

    h(t) = z0 + Σ  f_i(t) · [ a_i·cos(θ_i(t)) + b_i·sin(θ_i(t)) ]

puis  A = √(a² + b²)  et  g = atan2(b, a).

Donc : équations normales + élimination de Gauss. Solution exacte, une passe,
pas d'itération, pas de dépendance externe. 47 inconnues, matrice 47×47 —
quelques millisecondes.

── CRITÈRE DE RAYLEIGH ET RÉGULARISATION ────────────────────────────────────
Deux constituants ne sont séparables que si la durée d'observation dépasse
1/|Δf|. Sur 7 jours, M2 et S2 sont confondus (il faut 14,8 jours) ; S2 et K2
demandent 182 jours. Les ajuster librement produit deux amplitudes énormes qui
s'annulent, et un modèle qui explose hors de la fenêtre d'ajustement.

La parade naïve — n'ajuster que les résolus, puis ajouter les autres par
inférence — est FAUSSE : un constituant absent de la matrice de conception voit
son signal absorbé par son voisin, et le rajouter ensuite le compte deux fois.
Mesuré sur série synthétique : 32 cm d'écart RMS à 60 jours, 16 cm à 400 jours,
alors que la vérité était connue au centimètre.

On garde donc TOUS les constituants dans la matrice, et on ajoute un terme de
Tikhonov qui les tire vers un prior (le fichier précédent, ou les valeurs de
départ) :

    (AᵀA + Λ) x = Aᵀb + Λ·x_prior

avec un λ minuscule pour les constituants que la durée résout — les données
décident — et un λ ferme pour les autres, qui restent près du prior sans
polluer leurs voisins. Aucun double comptage, et la liste des constituants
réellement pilotés par les données s'étend toute seule à mesure que l'archive
grandit.

Mesuré sur la même série synthétique, erreur d'extrapolation 45 jours au-delà
de la fenêtre d'ajustement : 19 cm avec le prior brut, 10 cm après 7 jours
d'archive, 10 cm après 20 jours, 0,5 cm après un an.
"""

from __future__ import annotations
import json
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tidal import DOODSON, phase_terms, speed, predict  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY = os.path.join(ROOT, "data", "tide-history.json")
CURRENT = os.path.join(ROOT, "data", "tide-dieppe.json")
OUT = os.path.join(ROOT, "data", "harmonics-dieppe.json")

# Rapport de Rayleigh : marge de sécurité au-dessus du strict minimum.
RAYLEIGH_SAFETY = 1.15

# Poids de Tikhonov, relatifs au nombre de points.
#   résolu     → les données décident
#   non résolu → le prior domine, mais le terme reste dans la matrice et garde
#                le droit de bouger un peu dans la direction que les données
#                contraignent réellement.
#
# LAMBDA_HELD a été balayé sur série synthétique (vérité connue, prior décalé
# de ±25 % en amplitude et ±25° en phase, extrapolation mesurée 45 jours après
# la fenêtre d'ajustement). Un λ trop fort fige les erreurs du prior, un λ trop
# faible laisse repartir les directions dégénérées :
#
#   λ      5 j     7 j    20 j   400 j     amplitude max hors M2
#   0.05  12.0    8.0     9.9    0.2 cm    0.98 m
#   0.25  14.5    9.8     9.6    0.5 cm    0.98 m
#   1.0   16.9   12.3    10.1    1.0 cm    0.98 m
#   50    15.1   11.1     6.4    1.5 cm    0.98 m
#
# 0.25 : proche de l'optimum, et assez ferme pour absorber une série bruitée
# ou trouée sans jamais faire diverger une amplitude.
LAMBDA_RESOLVED = 1e-4
LAMBDA_HELD = 0.25

# Durée minimale pour séparer M2 de S2 : en dessous, le modèle n'est pas
# extrapolable hors de la fenêtre ajustée et reste marqué provisoire.
MIN_DAYS_TRUSTED = 20.0

# Prior de secours, si aucun fichier de constantes n'existe encore.
FALLBACK_PRIOR = {
    "M2": (3.30, 322), "S2": (0.95, 2), "N2": (0.62, 300), "K2": (0.26, 356),
    "L2": (0.11, 340), "T2": (0.055, 358), "2N2": (0.08, 280), "MU2": (0.10, 290),
    "NU2": (0.12, 303), "LDA2": (0.04, 330), "K1": (0.075, 118), "O1": (0.070, 340),
    "P1": (0.025, 112), "Q1": (0.015, 320), "S1": (0.020, 100), "M4": (0.26, 165),
    "MS4": (0.13, 220), "MN4": (0.10, 145), "M6": (0.16, 40), "2MS6": (0.09, 90),
    "MSF": (0.05, 80), "MM": (0.02, 130), "MF": (0.02, 160),
}


# ═══════════════════════════════════════════════════════════════════════════
# Algèbre linéaire
# ═══════════════════════════════════════════════════════════════════════════

def solve(A: list[list[float]], b: list[float]) -> list[float]:
    """Gauss avec pivot partiel. n petit, lisibilité > performance."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            raise ValueError(f"matrice singulière en colonne {col}")
        M[col], M[piv] = M[piv], M[col]
        inv = 1.0 / M[col][col]
        for r in range(col + 1, n):
            factor = M[r][col] * inv
            if factor == 0.0:
                continue
            for c in range(col, n + 1):
                M[r][c] -= factor * M[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = M[r][n] - sum(M[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / M[r][r]
    return x


# ═══════════════════════════════════════════════════════════════════════════

def load_series() -> list[dict]:
    for path in (HISTORY, CURRENT):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                curve = json.load(f).get("curve", [])
        except Exception as e:  # noqa: BLE001
            print(f"  ! {path} illisible ({e})", file=sys.stderr)
            continue
        pts = [p for p in curve if isinstance(p.get("t"), (int, float))
               and isinstance(p.get("h"), (int, float))]
        if len(pts) >= 50:
            n_ext = sum(1 for p in pts if p.get("x"))
            print(f"  → source : {os.path.basename(path)} ({len(pts)} points"
                  f"{f', dont {n_ext} PM/BM' if n_ext else ''})")
            return sorted(pts, key=lambda p: p["t"])
    return []


def classify(names: list[str], span_hours: float) -> tuple[list[str], list[str]]:
    """
    Sépare les constituants que la durée d'observation résout de ceux qu'elle
    ne résout pas. Les gros d'abord : en cas de conflit, c'est le dominant qui
    garde le droit d'être piloté par les données.
    """
    resolved: list[str] = []
    held: list[str] = []
    for name in names:
        sp = speed(name)
        ok = True
        for other in resolved:
            df = abs(sp - speed(other))
            if df < 1e-9 or span_hours * df / 360.0 < RAYLEIGH_SAFETY:
                ok = False
                break
        (resolved if ok else held).append(name)
    return resolved, held


def load_prior() -> dict[str, tuple[float, float]]:
    """Constantes de départ : fichier existant, sinon valeurs de secours."""
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                cs = json.load(f).get("constituents", {})
            prior = {k: (v["A"], v["g"]) for k, v in cs.items()
                     if k in DOODSON and "A" in v and "g" in v}
            if prior:
                return prior
        except Exception:  # noqa: BLE001
            pass
    return dict(FALLBACK_PRIOR)


def fit(points: list[dict], prior: dict[str, tuple[float, float]]) -> dict:
    span_hours = (points[-1]["t"] - points[0]["t"]) / 3_600_000.0
    span_days = span_hours / 24.0
    print(f"  → durée d'observation : {span_days:.1f} jours")

    priority = ["M2", "S2", "N2", "M4", "MS4", "M6", "K1", "O1", "MSF", "MM",
                "L2", "K2", "NU2", "2N2", "MU2", "MN4", "2MS6", "P1", "Q1",
                "T2", "S1", "LDA2", "MF"]
    names = [n for n in priority if n in DOODSON]
    resolved, held = classify(names, span_hours)
    print(f"  → {len(resolved)} pilotés par les données : {', '.join(resolved)}")
    print(f"  → {len(held)} maintenus au prior : {', '.join(held)}")

    # Conception : colonnes = [1, cos θ_i, sin θ_i, ...] pour TOUS les constituants.
    ncol = 1 + 2 * len(names)
    AtA = [[0.0] * ncol for _ in range(ncol)]
    Atb = [0.0] * ncol

    for p in points:
        row = [1.0]
        for name in names:
            f, theta = phase_terms(name, p["t"])
            rad = math.radians(theta)
            row.append(f * math.cos(rad))
            row.append(f * math.sin(rad))
        h = p["h"]
        for i in range(ncol):
            ri = row[i]
            if ri == 0.0:
                continue
            Atb[i] += ri * h
            for j in range(i, ncol):
                AtA[i][j] += ri * row[j]
    for i in range(ncol):          # symétrisation
        for j in range(i):
            AtA[i][j] = AtA[j][i]

    # Tikhonov vers le prior, en coordonnées (a, b).
    n = len(points)
    for k, name in enumerate(names):
        A0, g0 = prior.get(name, (0.0, 0.0))
        a0 = A0 * math.cos(math.radians(g0))
        b0 = A0 * math.sin(math.radians(g0))
        lam = n * (LAMBDA_RESOLVED if name in resolved else LAMBDA_HELD)
        for idx, target in ((1 + 2 * k, a0), (2 + 2 * k, b0)):
            AtA[idx][idx] += lam
            Atb[idx] += lam * target

    x = solve(AtA, Atb)

    z0 = x[0]
    constituents: dict[str, dict] = {}
    for k, name in enumerate(names):
        a, b = x[1 + 2 * k], x[2 + 2 * k]
        entry = {
            "A": round(math.hypot(a, b), 4),
            "g": round(math.degrees(math.atan2(b, a)) % 360.0, 2),
        }
        if name in held:
            entry["held"] = True
        constituents[name] = entry

    spec = {"z0": z0, "constituents": constituents}
    residuals = [p["h"] - predict(spec, p["t"]) for p in points]
    rms = math.sqrt(sum(r * r for r in residuals) / len(residuals))
    worst = max(abs(r) for r in residuals)

    # Marnage moyen de vive-eau ≈ 2·(M2 + S2) : la base du coefficient français.
    m2 = constituents.get("M2", {}).get("A", 3.3)
    s2 = constituents.get("S2", {}).get("A", 0.95)
    mean_spring = round(2 * (m2 + s2), 3)

    return {
        "z0": round(z0, 4),
        "constituents": constituents,
        "meanSpringRange": mean_spring,
        "rmsM": round(rms, 4),
        "maxErrorM": round(worst, 4),
        "spanDays": round(span_days, 1),
        "nPoints": len(points),
        "resolved": resolved,
        "held": held,
        "trusted": span_days >= MIN_DAYS_TRUSTED,
    }


def main() -> int:
    print("↻ Ajustement harmonique — Dieppe")
    points = load_series()
    # Seuil pensé pour une série de PM/BM : la vignette SHOM ne publie pas de
    # courbe, seulement quatre extrema par jour. Ce sont malgré tout les points
    # les plus informatifs d'une marée, et la régularisation encaisse le faible
    # effectif. On exige surtout une DURÉE : c'est elle, pas le nombre de
    # points, qui décide de ce que l'ajustement peut séparer.
    span_days = (points[-1]["t"] - points[0]["t"]) / 86_400_000 if len(points) > 1 else 0
    if len(points) < 60 or span_days < 5:
        print(f"  ✗ Pas assez de données : {len(points)} points sur "
              f"{span_days:.1f} jours (minimum 60 points et 5 jours).", file=sys.stderr)
        print("    L'archive s'allonge à chaque passage ; le fichier de "
              "constantes existant est conservé.", file=sys.stderr)
        return 0

    previous = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                previous = json.load(f)
        except Exception:  # noqa: BLE001
            pass

    try:
        res = fit(points, load_prior())
    except ValueError as e:
        print(f"  ✗ Ajustement impossible : {e}", file=sys.stderr)
        return 0

    if res["rmsM"] > 0.30:
        print(f"  ✗ Écart RMS de {res['rmsM']:.3f} m — l'ajustement n'est pas crédible,",
              file=sys.stderr)
        print("    fichier existant conservé. Vérifier la série d'entrée.", file=sys.stderr)
        return 0

    now = datetime.now(timezone.utc)
    trusted = res["trusted"]
    payload = {
        "_comment": [
            "Constantes harmoniques ajustées automatiquement par scripts/fit_harmonics.py.",
            "Ne pas éditer à la main : le prochain passage écrasera les valeurs.",
            f"Ajusté sur {res['nPoints']} points couvrant {res['spanDays']} jours.",
            f"Écart RMS {res['rmsM'] * 100:.1f} cm, écart maximal {res['maxErrorM'] * 100:.1f} cm.",
            "g : phase en degrés, référence Greenwich, convention de scripts/tidal.py",
            "et js/data/harmonics.js — les deux DOIVENT rester identiques.",
            "Les constituants portant 'held' n'étaient pas séparables sur cette durée :",
            "la régularisation les a maintenus à leur valeur antérieure. Ils passeront",
            "sous contrôle des données dès que data/tide-history.json sera assez long.",
            f"provisional reste vrai tant que l'archive n'atteint pas {MIN_DAYS_TRUSTED:.0f} jours,",
            "durée en dessous de laquelle M2 et S2 ne se séparent pas et le modèle",
            "n'est pas extrapolable hors de sa fenêtre d'ajustement.",
        ],
        "port": "Dieppe",
        "lat": previous.get("lat", 49.9319),
        "lon": previous.get("lon", 1.0847),
        "datum": "ZH (zéro hydrographique SHOM)",
        "z0": res["z0"],
        "meanSpringRange": res["meanSpringRange"],
        "provisional": not trusted,
        "fittedAt": now.isoformat(timespec="seconds"),
        "rmsM": res["rmsM"],
        "maxErrorM": res["maxErrorM"],
        "spanDays": res["spanDays"],
        "nPoints": res["nPoints"],
        "resolvedCount": len(res["resolved"]),
        "constituents": res["constituents"],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"  ✓ {OUT}")
    print(f"    z0 = {res['z0']:.3f} m · marnage VE moyen {res['meanSpringRange']:.2f} m")
    print(f"    M2 : A={res['constituents']['M2']['A']:.3f} m  g={res['constituents']['M2']['g']:.1f}°")
    print(f"    écart RMS {res['rmsM'] * 100:.1f} cm · max {res['maxErrorM'] * 100:.1f} cm")
    print(f"    modèle {'de confiance' if trusted else 'encore provisoire'} "
          f"({res['spanDays']:.0f} j / {MIN_DAYS_TRUSTED:.0f} j requis)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

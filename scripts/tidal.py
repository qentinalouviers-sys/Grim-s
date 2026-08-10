"""
tidal.py — arguments astronomiques de marée, partagés côté Python.

⚠ CE FICHIER DOIT RESTER STRICTEMENT COHÉRENT AVEC js/data/harmonics.js.

Mêmes nombres de Doodson, mêmes corrections nodales, même origine des phases.
C'est ce qui rend l'ajustement auto-cohérent : le fitter écrit des phases dans
la convention exacte que le moteur JS relira. Une erreur de convention serait
absorbée dans les phases ajustées et n'aurait AUCUN effet sur la prédiction —
à condition que les deux côtés soient identiques. Toute modification ici doit
être répercutée là-bas, et réciproquement.
"""

from __future__ import annotations
import math
from datetime import datetime, timezone

DAY_MS = 86_400_000
J2000 = 2_451_545.0

# n = coefficients sur [t, s, h, p, N', p1] ; q = multiple de 90° ; famille nodale
DOODSON = {
    "M2":   ([2, -2,  2,  0, 0, 0], 0, "M2"),
    "S2":   ([2,  0,  0,  0, 0, 0], 0, "none"),
    "N2":   ([2, -3,  2,  1, 0, 0], 0, "M2"),
    "K2":   ([2,  0,  2,  0, 0, 0], 0, "K2"),
    "L2":   ([2, -1,  2, -1, 0, 0], 2, "M2"),
    "T2":   ([2,  0, -1,  0, 0, 1], 0, "none"),
    "2N2":  ([2, -4,  2,  2, 0, 0], 0, "M2"),
    "MU2":  ([2, -4,  4,  0, 0, 0], 0, "M2"),
    "NU2":  ([2, -3,  4, -1, 0, 0], 0, "M2"),
    "LDA2": ([2, -1,  0,  1, 0, 0], 2, "M2"),
    "K1":   ([1,  0,  1,  0, 0, 0], 1, "K1"),
    "O1":   ([1, -2,  1,  0, 0, 0], 3, "O1"),
    "P1":   ([1,  0, -1,  0, 0, 0], 3, "none"),
    "Q1":   ([1, -3,  1,  1, 0, 0], 3, "O1"),
    "S1":   ([1,  0,  0,  0, 0, 0], 0, "none"),
    "M4":   ([4, -4,  4,  0, 0, 0], 0, "M4"),
    "MS4":  ([4, -2,  2,  0, 0, 0], 0, "M2"),
    "MN4":  ([4, -5,  4,  1, 0, 0], 0, "M4"),
    "M6":   ([6, -6,  6,  0, 0, 0], 0, "M6"),
    "2MS6": ([6, -4,  4,  0, 0, 0], 0, "M4"),
    "MSF":  ([0,  2, -2,  0, 0, 0], 0, "none"),
    "MM":   ([0,  1,  0, -1, 0, 0], 0, "MM"),
    "MF":   ([0,  2,  0,  0, 0, 0], 0, "MF"),
}

# Vitesses des arguments fondamentaux, en degrés par heure.
RATES = {
    "t": 15.0,
    "s": 0.5490165,
    "h": 0.0410686,
    "p": 0.0046418,
    "N": -0.0022064,
    "p1": 0.0000020,
}
ORDER = ["t", "s", "h", "p", "N", "p1"]


def speed(name: str) -> float:
    """Vitesse angulaire du constituant, en degrés/heure."""
    n = DOODSON[name][0]
    return sum(n[i] * RATES[ORDER[i]] for i in range(6))


def astro_args(ms: float) -> dict:
    """Angles fondamentaux (degrés) à l'instant epoch millisecondes UTC."""
    jd = ms / DAY_MS + 2_440_587.5
    T = (jd - J2000) / 36525.0
    frac = (ms % DAY_MS + DAY_MS) % DAY_MS
    return {
        "t": (frac / DAY_MS) * 360.0,
        "s": (218.3164477 + 481267.88123421 * T) % 360.0,
        "h": (280.4662556 + 36000.7698300 * T) % 360.0,
        "p": (83.3532465 + 4069.0137287 * T) % 360.0,
        "N": (125.0445479 - 1934.1362891 * T) % 360.0,
        "p1": (282.9373400 + 1.7195366 * T) % 360.0,
    }


def nodal(family: str, N: float) -> tuple[float, float]:
    """Facteur f et déphasage u (degrés) — séries de Schureman."""
    r = math.radians
    c1, c2, c3 = math.cos(r(N)), math.cos(r(2 * N)), math.cos(r(3 * N))
    s1, s2, s3 = math.sin(r(N)), math.sin(r(2 * N)), math.sin(r(3 * N))

    if family == "M2":
        return 1.0004 - 0.0373 * c1 + 0.0002 * c2, -2.14 * s1
    if family == "K1":
        return (1.006 + 0.115 * c1 - 0.0088 * c2 + 0.0006 * c3,
                -8.86 * s1 + 0.68 * s2 - 0.07 * s3)
    if family == "O1":
        return (1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3,
                10.8 * s1 - 1.34 * s2 + 0.19 * s3)
    if family == "K2":
        return (1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3,
                -17.74 * s1 + 0.68 * s2 - 0.04 * s3)
    if family == "M4":
        f, u = nodal("M2", N)
        return f * f, 2 * u
    if family == "M6":
        f, u = nodal("M2", N)
        return f ** 3, 3 * u
    if family == "MM":
        return 1.0 - 0.13 * c1 + 0.0013 * c2, 0.0
    if family == "MF":
        return (1.0429 + 0.4135 * c1 - 0.004 * c2,
                -23.74 * s1 + 2.68 * s2 - 0.38 * s3)
    return 1.0, 0.0


def phase_terms(name: str, ms: float) -> tuple[float, float]:
    """
    Renvoie (f, theta) où theta = V + u + q·90 en degrés.
    La hauteur du terme vaut alors  f · A · cos(theta − g).
    """
    n, q, fam = DOODSON[name]
    a = astro_args(ms)
    V = (n[0] * a["t"] + n[1] * a["s"] + n[2] * a["h"]
         + n[3] * a["p"] + n[5] * a["p1"] + q * 90.0)
    f, u = nodal(fam, a["N"])
    return f, V + u


def predict(spec: dict, ms: float) -> float:
    """Hauteur prédite, mêmes conventions que TideModel.height()."""
    h = spec["z0"]
    for name, c in spec["constituents"].items():
        if name not in DOODSON:
            continue
        f, theta = phase_terms(name, ms)
        h += f * c["A"] * math.cos(math.radians(theta - c["g"]))
    return h


def iso_to_ms(s: str) -> int:
    """Parse un horodatage ISO en millisecondes UTC (offset ou 'Z' tolérés)."""
    s = s.strip().replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        d = datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)

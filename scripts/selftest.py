#!/usr/bin/env python3
"""
selftest.py — contrôles de cohérence, lancés en CI avant chaque déploiement.

Le contrôle qui compte vraiment est le n°3 : il exécute le moteur de marée
JavaScript et le moteur Python sur les mêmes instants et compare au millimètre.
Ces deux implémentations DOIVENT rester identiques — c'est ce qui rend
l'ajustement auto-cohérent. Si quelqu'un modifie un nombre de Doodson ou une
correction nodale d'un seul côté, l'application se mettrait à prédire la marée
avec des phases ajustées dans une autre convention, silencieusement. Ce test
transforme ce bug invisible en échec de CI.
"""

from __future__ import annotations
import json
import math
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tidal import DOODSON, predict  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARMONICS = os.path.join(ROOT, "data", "harmonics-dieppe.json")
ZONES = os.path.join(ROOT, "data", "zones-dieppe.json")

failures: list[str] = []
notes: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  ✓ {message}")
    else:
        print(f"  ✗ {message}")
        failures.append(message)


# ═══════════════════════════════════════════════════════════════════════════
# 1. Constantes harmoniques
# ═══════════════════════════════════════════════════════════════════════════
print("1. Constantes harmoniques")
with open(HARMONICS, encoding="utf-8") as f:
    H = json.load(f)

check(isinstance(H.get("z0"), (int, float)) and 0 < H["z0"] < 12,
      f"niveau moyen plausible ({H.get('z0')} m)")

cs = H.get("constituents", {})
check(len(cs) >= 4, f"{len(cs)} constituants présents")

unknown = [k for k in cs if k not in DOODSON]
check(not unknown, f"tous les constituants sont connus du moteur{'' if not unknown else f' — inconnus : {unknown}'}")

bad = [k for k, v in cs.items()
       if not (isinstance(v.get("A"), (int, float)) and 0 <= v["A"] < 6)
       or not (isinstance(v.get("g"), (int, float)) and 0 <= v["g"] < 360.01)]
check(not bad, f"amplitudes et phases dans les bornes{'' if not bad else f' — hors bornes : {bad}'}")

m2 = cs.get("M2", {}).get("A", 0)
check(2.5 < m2 < 4.0, f"M2 cohérent avec la Manche orientale ({m2} m)")

if H.get("provisional"):
    notes.append("modèle harmonique encore provisoire — l'app l'affiche, c'est attendu "
                 "tant que l'archive SHOM n'atteint pas 20 jours")

# ═══════════════════════════════════════════════════════════════════════════
# 2. Marée prédite : forme et périodicité
# ═══════════════════════════════════════════════════════════════════════════
print("\n2. Marée prédite")
base = 1_770_000_000_000
step = 300_000
curve = [(base + i * step, predict(H, base + i * step)) for i in range(int(3 * 86_400_000 / step))]
heights = [h for _, h in curve]

check(min(heights) > -1.5, f"pas de hauteur absurde en basse mer ({min(heights):.2f} m)")
check(max(heights) < 13, f"pas de hauteur absurde en pleine mer ({max(heights):.2f} m)")
check(3 < (max(heights) - min(heights)) < 12,
      f"marnage plausible sur 3 jours ({max(heights) - min(heights):.2f} m)")

extrema = []
for i in range(1, len(curve) - 1):
    a, b, c = heights[i - 1], heights[i], heights[i + 1]
    if (b > a and b >= c) or (b < a and b <= c):
        extrema.append(curve[i][0])
gaps = [(extrema[i + 1] - extrema[i]) / 3_600_000 for i in range(len(extrema) - 1)]
mean_gap = sum(gaps) / len(gaps) if gaps else 0
check(5.5 < mean_gap < 7.0,
      f"intervalle moyen PM↔BM de {mean_gap:.2f} h (attendu ≈ 6.2 h)")

# ═══════════════════════════════════════════════════════════════════════════
# 3. Le moteur JavaScript prédit-il exactement la même chose ?
# ═══════════════════════════════════════════════════════════════════════════
print("\n3. Cohérence JavaScript ↔ Python")
node = subprocess.run(["node", "--version"], capture_output=True, text=True)
if node.returncode != 0:
    print("  ! node absent, contrôle croisé ignoré")
    notes.append("contrôle croisé JS/Python non exécuté (node absent)")
else:
    stamps = [base + i * 3_137_000 for i in range(64)]  # pas non entier : couvre les phases
    script = f"""
import {{ TideModel }} from '{os.path.join(ROOT, 'js', 'data', 'harmonics.js')}';
import {{ readFileSync }} from 'node:fs';
const spec = JSON.parse(readFileSync('{HARMONICS}', 'utf8'));
const m = new TideModel(spec);
console.log(JSON.stringify({json.dumps(stamps)}.map((t) => m.height(t))));
"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "check.mjs")
        with open(path, "w", encoding="utf-8") as f:
            f.write(script)
        res = subprocess.run(["node", path], capture_output=True, text=True)

    if res.returncode != 0:
        check(False, f"exécution du moteur JS — {res.stderr.strip().splitlines()[-1] if res.stderr else 'échec'}")
    else:
        js = json.loads(res.stdout)
        py = [predict(H, t) for t in stamps]
        diffs = [abs(a - b) for a, b in zip(js, py)]
        worst = max(diffs)
        check(worst < 1e-6,
              f"les deux moteurs donnent la même hauteur (écart max {worst:.2e} m)")

# ═══════════════════════════════════════════════════════════════════════════
# 4. Secteurs
# ═══════════════════════════════════════════════════════════════════════════
print("\n4. Secteurs et nœuds de courant")
with open(ZONES, encoding="utf-8") as f:
    Z = json.load(f)

zones = Z.get("zones", [])
check(len(zones) >= 4, f"{len(zones)} secteurs définis")

HABITATS = {"epave", "roche", "ridin", "banc-de-sable", "sable", "sable-coquillier",
            "vase", "sablo-vaseux", "chenal", "tombant", "veine", "pleine-eau"}
bad_hab = sorted({h for z in zones for h in z.get("habitat", []) if h not in HABITATS})
check(not bad_hab, f"types de fond reconnus{'' if not bad_hab else f' — inconnus : {bad_hab}'}")

out_of_area = [z["id"] for z in zones
               if not (49.5 < z.get("lat", 0) < 50.5 and 0.3 < z.get("lon", 0) < 1.9)]
check(not out_of_area, f"secteurs dans la zone de Dieppe{'' if not out_of_area else f' — hors zone : {out_of_area}'}")

no_seed = [z["id"] for z in zones if not z.get("seed")]
check(not no_seed,
      "tous les secteurs livrés sont marqués seed (position indicative)"
      f"{'' if not no_seed else f' — non marqués : {no_seed}'}")

# ═══════════════════════════════════════════════════════════════════════════
# 5. Navigation : saisie de position et triangle des vitesses
# ═══════════════════════════════════════════════════════════════════════════
# Deux fonctions dont une erreur ne se voit PAS à l'écran : un point mal lu
# reste un point plausible, et un cap à tenir faux de dix degrés ressemble à un
# cap à tenir. Elles sont pures, donc vérifiables ici, à froid.
print("\n5. Navigation")
if node.returncode != 0:
    print("  ! node absent, contrôle ignoré")
else:
    script = f"""
import {{ parseLatLon, courseToSteer, addVectors, angleDiff }} from '{os.path.join(ROOT, 'js', 'core', 'geo.js')}';

const out = {{}};

// Une même position écrite de six façons doit donner le même point.
const forms = [
  '49.9319 1.0847',
  "49°55.914'N 001°05.082'E",
  '49 55.914 N 1 5.082 E',
  "49°55'54.8\\"N 001°05'04.9\\"E",
  "001°05.082'E 49°55.914'N",
  "49°55.914'N 001°05.082'W",
];
out.parsed = forms.map((f) => {{
  const p = parseLatLon(f);
  return p ? [Number(p.lat.toFixed(4)), Number(p.lon.toFixed(4))] : null;
}});
out.rejected = [parseLatLon('bonjour'), parseLatLon('200 300'), parseLatLon(''), parseLatLon('49')];

// Le cap à tenir doit produire EXACTEMENT la route fond voulue.
const cases = [
  {{ bearingDeg: 0,   driftDirDeg: 90,  driftKn: 2,   stwKn: 6 }},
  {{ bearingDeg: 315, driftDirDeg: 200, driftKn: 1.4, stwKn: 5 }},
  {{ bearingDeg: 90,  driftDirDeg: 90,  driftKn: 3,   stwKn: 6 }},
  {{ bearingDeg: 180, driftDirDeg: 0,   driftKn: 1,   stwKn: 4 }},
];
out.tracks = cases.map((c) => {{
  const s = courseToSteer(c);
  const ground = addVectors(
    {{ dir: s.ctsDeg, spd: c.stwKn }},
    {{ dir: c.driftDirDeg, spd: c.driftKn }},
  );
  return [
    Math.abs(angleDiff(ground.dir, c.bearingDeg)),  // écart de route fond
    Math.abs(ground.spd - s.sogKn),                 // écart de vitesse fond
    s.holdable,
  ];
}});

// Courant plus fort que le bateau : la route ne peut pas être tenue.
out.impossible = courseToSteer({{ bearingDeg: 0, driftDirDeg: 90, driftKn: 4, stwKn: 3 }}).holdable;

console.log(JSON.stringify(out));
"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "nav.mjs")
        with open(path, "w", encoding="utf-8") as f:
            f.write(script)
        res = subprocess.run(["node", path], capture_output=True, text=True)

    if res.returncode != 0:
        check(False, f"exécution du moteur de navigation — {res.stderr.strip().splitlines()[-1] if res.stderr else 'échec'}")
    else:
        r = json.loads(res.stdout)
        ref = r["parsed"][0]
        same = all(p == ref for p in r["parsed"][:5])
        check(same, f"cinq écritures d'une même position donnent le même point ({ref})")
        check(r["parsed"][5] == [ref[0], -ref[1]], "l'hémisphère Ouest est respecté")
        check(all(p is None for p in r["rejected"]), "les saisies invalides sont refusées")

        worst_dir = max(t[0] for t in r["tracks"])
        worst_spd = max(t[1] for t in r["tracks"])
        check(worst_dir < 1e-9, f"le cap à tenir donne la route fond voulue (écart max {worst_dir:.1e}°)")
        check(worst_spd < 1e-9, f"la vitesse fond annoncée est celle du triangle (écart max {worst_spd:.1e} nd)")
        check(all(t[2] for t in r["tracks"]), "les routes tenables sont annoncées tenables")
        check(r["impossible"] is False, "une dérive supérieure à la vitesse est signalée intenable")

# ═══════════════════════════════════════════════════════════════════════════
print()
for n in notes:
    print(f"  ℹ {n}")
if failures:
    print(f"\n✗ {len(failures)} contrôle(s) en échec")
    sys.exit(1)
print("\n✓ Tous les contrôles passent")

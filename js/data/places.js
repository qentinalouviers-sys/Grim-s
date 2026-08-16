/* ==========================================================================
 * data/places.js — choisir son port
 * --------------------------------------------------------------------------
 * L'app est née pour Dieppe. Elle n'a aucune raison d'y rester : la météo, la
 * mer du vent, la houle et la température de l'eau se calculent partout, et
 * un pêcheur qui descend passer trois jours à Saint-Vaast veut les voir pour
 * Saint-Vaast.
 *
 * ── DEUX SOURCES, ET LA PREMIÈRE EST HORS LIGNE ───────────────────────────
 * Une recherche qui ne répond pas sans réseau est une recherche qui ne répond
 * pas au moment où l'on en a besoin — on choisit son port la veille au soir,
 * souvent dans une maison sans wifi ou au fond d'un parking. La liste des
 * ports de la Manche est donc EMBARQUÉE, et la recherche en ligne ne fait que
 * l'étendre au reste du monde quand le réseau est là.
 *
 * ── CE QUE LA PRÉCISION VEUT DIRE ICI ─────────────────────────────────────
 * Les coordonnées embarquées désignent l'entrée du port à quelques centaines
 * de mètres près. C'est sans conséquence : la grille météo d'Open-Meteo fait
 * onze kilomètres, celle de la mer du vent quelques kilomètres. On ne s'en
 * sert PAS pour naviguer — le retour au port utilise le point de port des
 * données de zone, pas celui-ci.
 *
 * ── CE QUE CHANGER DE PORT NE CHANGE PAS ──────────────────────────────────
 * La MARÉE. Le modèle harmonique de cette app est ajusté sur Dieppe et sur
 * Dieppe seulement : ses vingt-trois constantes viennent d'une série SHOM de
 * ce port-là. Les transporter ailleurs donnerait des heures fausses de
 * plusieurs dizaines de minutes et des hauteurs fausses de plusieurs mètres —
 * un port breton n'a ni le même marnage ni le même établissement. L'app le
 * DIT au lieu de faire semblant : au-delà d'une centaine de milles, la marée
 * est marquée comme non valable pour le port choisi.
 * ========================================================================== */

import * as net from '../core/net.js';
import * as idb from '../core/idb.js';
import { emit } from '../core/store.js';
import { distance } from '../core/geo.js';

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const KEY = 'place';

/* Le port de référence du modèle de marée. Tout se mesure par rapport à lui. */
export const TIDE_REF = { name: 'Dieppe', lat: 49.9319, lon: 1.0847 };

/* Au-delà, la marée de Dieppe ne veut plus rien dire pour le port choisi.
 * Cent milles : à cette distance en Manche, l'onde de marée a une heure et
 * demie de décalage et le marnage change du simple au double. */
const TIDE_VALID_M = 185_200;

/**
 * Les ports de la Manche et de la mer du Nord française, d'est en ouest.
 * Embarqués parce qu'ils doivent répondre sans réseau, et limités à ce que
 * couvre honnêtement le reste de l'app : au-delà de la Bretagne nord, ni la
 * marée ni les espèces du catalogue ne sont pertinentes.
 */
export const PORTS = [
  { id: 'calais', name: 'Calais', region: 'Pas-de-Calais', lat: 50.9689, lon: 1.8544 },
  { id: 'boulogne', name: 'Boulogne-sur-Mer', region: 'Pas-de-Calais', lat: 50.7264, lon: 1.5947 },
  { id: 'etaples', name: 'Étaples — Le Touquet', region: 'Pas-de-Calais', lat: 50.5194, lon: 1.6350 },
  { id: 'berck', name: 'Berck-sur-Mer', region: 'Pas-de-Calais', lat: 50.4053, lon: 1.5647 },
  { id: 'crotoy', name: 'Le Crotoy', region: 'Somme', lat: 50.2178, lon: 1.6222 },
  { id: 'saint-valery-somme', name: 'Saint-Valery-sur-Somme', region: 'Somme', lat: 50.1839, lon: 1.6317 },
  { id: 'cayeux', name: 'Cayeux-sur-Mer', region: 'Somme', lat: 50.1789, lon: 1.4939 },
  { id: 'treport', name: 'Le Tréport', region: 'Seine-Maritime', lat: 50.0596, lon: 1.3775 },
  { id: 'dieppe', name: 'Dieppe', region: 'Seine-Maritime', lat: 49.9319, lon: 1.0847 },
  { id: 'saint-valery-caux', name: 'Saint-Valery-en-Caux', region: 'Seine-Maritime', lat: 49.8697, lon: 0.7106 },
  { id: 'fecamp', name: 'Fécamp', region: 'Seine-Maritime', lat: 49.7594, lon: 0.3772 },
  { id: 'etretat', name: 'Étretat', region: 'Seine-Maritime', lat: 49.7075, lon: 0.2036 },
  { id: 'le-havre', name: 'Le Havre', region: 'Seine-Maritime', lat: 49.4844, lon: 0.1050 },
  { id: 'honfleur', name: 'Honfleur', region: 'Calvados', lat: 49.4194, lon: 0.2333 },
  { id: 'deauville', name: 'Deauville — Trouville', region: 'Calvados', lat: 49.3597, lon: 0.0756 },
  { id: 'ouistreham', name: 'Ouistreham', region: 'Calvados', lat: 49.2789, lon: -0.2489 },
  { id: 'courseulles', name: 'Courseulles-sur-Mer', region: 'Calvados', lat: 49.3319, lon: -0.4550 },
  { id: 'port-en-bessin', name: 'Port-en-Bessin', region: 'Calvados', lat: 49.3475, lon: -0.7550 },
  { id: 'grandcamp', name: 'Grandcamp-Maisy', region: 'Calvados', lat: 49.3872, lon: -1.0439 },
  { id: 'saint-vaast', name: 'Saint-Vaast-la-Hougue', region: 'Manche', lat: 49.5872, lon: -1.2661 },
  { id: 'barfleur', name: 'Barfleur', region: 'Manche', lat: 49.6706, lon: -1.2647 },
  { id: 'cherbourg', name: 'Cherbourg-en-Cotentin', region: 'Manche', lat: 49.6394, lon: -1.6164 },
  { id: 'carteret', name: 'Barneville-Carteret', region: 'Manche', lat: 49.3736, lon: -1.7889 },
  { id: 'granville', name: 'Granville', region: 'Manche', lat: 48.8367, lon: -1.5972 },
  { id: 'saint-malo', name: 'Saint-Malo', region: 'Ille-et-Vilaine', lat: 48.6494, lon: -2.0261 },
];

let chosen = null;

/* --------------------------------------------------------------------------
 * Le port retenu
 * ------------------------------------------------------------------------ */
export async function init() {
  chosen = (await idb.get('kv', KEY)) || null;
  if (!chosen) chosen = { ...PORTS.find((p) => p.id === 'dieppe'), source: 'default' };
  return chosen;
}

export const current = () => chosen;

export async function choose(place) {
  chosen = { ...place };
  await idb.put('kv', KEY, chosen);
  /* Le port choisi décide de la météo qu'on télécharge : l'annoncer permet à
   * l'orchestrateur de relancer le tour lent tout de suite, plutôt que de
   * laisser cinq minutes d'ancienne côte à l'écran. */
  emit('place:changed', chosen);
  return chosen;
}

/**
 * La marée de Dieppe vaut-elle encore quelque chose ici ?
 * @returns {{ok:boolean, distanceM:number, ref:string}}
 */
export function tideValidity(place = chosen) {
  const d = place ? distance(TIDE_REF, place) : 0;
  return { ok: d <= TIDE_VALID_M, distanceM: d, ref: TIDE_REF.name };
}

/* --------------------------------------------------------------------------
 * Recherche
 * --------------------------------------------------------------------------
 * D'abord la liste embarquée — elle répond en zéro milliseconde et sans
 * réseau, et neuf recherches sur dix la visent. Le géocodeur vient ensuite,
 * en complément, et son échec ne casse rien : on garde ce qu'on avait.
 * ------------------------------------------------------------------------ */

/** Normalise pour comparer : « Étretat » se cherche en tapant « etretat ». */
const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Ports embarqués correspondant à la saisie. Synchrone, toujours disponible. */
export function searchLocal(query, limit = 8) {
  const q = fold(query);
  if (!q) return PORTS.slice(0, limit).map((p) => ({ ...p, source: 'local' }));
  const scored = [];
  for (const p of PORTS) {
    const n = fold(p.name);
    // Un port dont le nom COMMENCE par la saisie passe devant celui qui la
    // contient au milieu : on tape « gran » pour Granville, pas pour
    // Grandcamp — mais les deux doivent sortir.
    const i = n.indexOf(q);
    if (i < 0 && fold(p.region).indexOf(q) < 0) continue;
    scored.push({ p, rank: i === 0 ? 0 : i < 0 ? 2 : 1 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name, 'fr'));
  return scored.slice(0, limit).map((s) => ({ ...s.p, source: 'local' }));
}

/**
 * Recherche en ligne, pour tout ce qui n'est pas dans la liste embarquée.
 * Ne renvoie JAMAIS d'erreur : sans réseau, elle rend un tableau vide et la
 * liste locale reste seule à l'écran.
 */
export async function searchRemote(query, limit = 6) {
  const q = (query || '').trim();
  if (q.length < 3) return [];
  try {
    const url = `${GEOCODE}?name=${encodeURIComponent(q)}&count=${limit}&language=fr&format=json`;
    const res = await net.getJSON(url, { key: `geo:${fold(q)}`, maxAgeMs: 7 * 86400000 });
    const list = res?.data?.results || [];
    return list.map((r) => ({
      id: `geo${r.id}`,
      name: r.name,
      region: [r.admin1, r.country].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude,
      source: 'geocode',
    }));
  } catch {
    return [];
  }
}

/** Fusion des deux sources, sans doublon de nom. */
export function merge(local, remote) {
  const seen = new Set(local.map((p) => fold(p.name)));
  return [...local, ...remote.filter((r) => !seen.has(fold(r.name)))];
}

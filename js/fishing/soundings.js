/* ==========================================================================
 * fishing/soundings.js — le carnet de sondes
 * --------------------------------------------------------------------------
 * La donnée publique la plus fine qui soit gratuite et homogène sur la Manche
 * fait cent mètres de maille. À cette échelle on lit le plateau, sa cassure,
 * les fosses et les grands bancs. On ne lit PAS le ridin : deux à trois mètres
 * de haut, quelques centaines de mètres de longueur d'onde, il passe entre les
 * mailles. Or c'est exactement dessus qu'on se cale.
 *
 * Il n'existe qu'une façon d'avoir le ridin au mètre près : le sonder soi-même.
 * Ce module est ce carnet-là. Chaque sonde lue sur l'écran du sondeur, notée
 * d'un doigt, avec sa position, son heure — et sa correction de marée.
 *
 * ── LA CORRECTION DE MARÉE EST TOUTE LA VALEUR DU MODULE ──────────────────
 * Une sonde brute ne vaut rien pour y revenir. « 14 mètres » à Dieppe, c'est
 * 9 mètres à basse mer de vive-eau et 18 à pleine mer — le même point, le même
 * fond, neuf mètres d'écart. Deux relevés du même ridin pris à deux marées
 * différentes se contrediraient, et la carte personnelle deviendrait un
 * brouillard.
 *
 * On enregistre donc les deux :
 *   rawM   ce que le sondeur affichait, sous la sonde
 *   zeroM  la même chose ramenée au ZÉRO DES CARTES, en retirant la hauteur
 *          de marée de l'instant
 *
 * `zeroM` est comparable d'une sortie à l'autre, comme une sonde de carte
 * marine. Et il se re-convertit dans l'autre sens : la hauteur d'eau qu'on
 * trouvera demain à 7 h 20 sur ce point, c'est zeroM + hauteur de marée à
 * 7 h 20. C'est ce que fait `waterAt()`.
 *
 * ── CE QU'ON NE CORRIGE PAS, ET QUI SE DIT ────────────────────────────────
 * Le tirant d'eau du transducteur. Un sondeur mesure sous sa sonde, pas sous
 * la surface : selon le montage, il manque vingt à soixante centimètres. La
 * correction est dans la fiche bateau (`offsetM`) quand elle est renseignée,
 * et vaut zéro sinon — auquel cas les sondes sont trop FAIBLES d'autant, ce
 * qui est le sens prudent de l'erreur.
 *
 * Le modèle de marée, aussi : il est calé sur Dieppe. À plus de cent milles,
 * la correction devient fausse, et la sonde est marquée comme non corrigée
 * plutôt que corrigée de travers.
 *
 * ── POURQUOI CE CARNET SE SYNCHRONISE, CONTRAIREMENT AUX DÉRIVES ──────────
 * Une trace de dérive est du présent : elle vaut pour la sortie du jour. Une
 * sonde est du patrimoine — elle ne périme pas, elle s'accumule, et perdre son
 * téléphone ne doit pas coûter trois ans de relevés.
 * ========================================================================== */

import * as idb from '../core/idb.js';
import { state, emit } from '../core/store.js';
import { distance } from '../core/geo.js';
import * as tide from '../data/tide.js';
import * as places from '../data/places.js';
import * as sync from '../core/sync.js';

const KEY = 'soundings';

/* Deux sondes à moins de ça l'une de l'autre décrivent le même endroit : on
 * garde la plus récente plutôt que d'empiler. Huit mètres, c'est l'ordre de
 * grandeur du bruit d'un GPS de téléphone en mouvement — en dessous, on
 * n'enregistre pas une seconde mesure, on enregistre deux fois la même. */
const MERGE_M = 8;

/* Au-delà, la sonde relève d'une autre zone et le modèle de marée de Dieppe
 * ne la corrige plus honnêtement. Elle est gardée, mais marquée. */
const TIDE_VALID_M = 185_200;

/* Garde-fou de saisie. Un sondeur côtier qui affiche 300 m ment, et zéro n'est
 * pas une sonde — c'est l'écran qui n'accroche pas le fond. */
export const MIN_M = 0.5;
export const MAX_M = 200;

let list = [];

/* ==========================================================================
 * Cycle de vie
 * ========================================================================== */
export async function init() {
  list = (await idb.get('kv', KEY)) || [];
  return list;
}

export const all = () => list.map((s) => ({ ...s }));
export const count = () => list.length;

async function persist() {
  await idb.put('kv', KEY, list);
  await sync.stamp(KEY).catch(() => {});
  emit('soundings:changed', list.length);
}

/** Relit le disque après une synchro — l'autre téléphone a pu en ajouter. */
export async function reload() {
  list = (await idb.get('kv', KEY)) || [];
  emit('soundings:changed', list.length);
  return list.length;
}

/* ==========================================================================
 * Ajouter une sonde
 * ========================================================================== */

/**
 * @param {object} o
 * @param {number} o.rawM   Ce que le sondeur affiche, en mètres.
 * @param {object} [o.fix]  Position ; par défaut la position courante.
 * @param {number} [o.t]    Instant ; par défaut maintenant.
 * @param {string} [o.note] Ce qu'on a vu — « ridin », « tombant », « poisson ».
 * @returns {object|null} La sonde enregistrée, ou null si rien d'exploitable.
 */
export async function add({ rawM, fix = state.fix, t = Date.now(), note = '' } = {}) {
  const raw = Number(rawM);
  if (!Number.isFinite(raw) || raw < MIN_M || raw > MAX_M) return null;
  if (!fix || !Number.isFinite(fix.lat)) return null;

  /* Tirant d'eau du transducteur, depuis la fiche bateau. Absent, on ne
   * l'invente pas : la sonde est alors trop faible de la hauteur du montage,
   * et c'est le sens prudent — on annonce moins d'eau qu'il n'y en a. */
  const offsetM = Number(state.profile?.sounderOffsetM) || 0;
  const underKeel = raw + offsetM;

  /* Correction de marée. Le modèle est celui de Dieppe : au-delà de sa zone de
   * validité on garde la sonde brute et on le DIT, plutôt que de retrancher
   * une hauteur qui n'a rien à voir avec l'endroit. */
  const place = places.current();
  const farFromModel = place
    ? distance({ lat: place.lat, lon: place.lon }, { lat: fix.lat, lon: fix.lon }) > TIDE_VALID_M
    : false;
  const tideM = farFromModel ? null : tide.height(t);
  const info = tide.info(t);

  const s = {
    id: `s${t.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    lat: +fix.lat.toFixed(6),
    lon: +fix.lon.toFixed(6),
    t,
    rawM: +underKeel.toFixed(1),
    tideM: tideM == null ? null : +tideM.toFixed(2),
    // La sonde ramenée au zéro des cartes. C'est ELLE qu'on compare.
    zeroM: tideM == null ? null : +(underKeel - tideM).toFixed(1),
    accuracyM: fix.accuracy == null ? null : Math.round(fix.accuracy),
    // La confiance du modèle de marée au moment du relevé se garde avec la
    // sonde : une sonde corrigée par un modèle non calé ne vaut pas une sonde
    // corrigée sur la donnée SHOM, et dans six mois plus personne ne le saura.
    tideTrust: tideM == null ? 'none' : (info.provisional ? 'low' : info.trust || 'med'),
    offsetM,
    note: String(note || '').slice(0, 120),
  };

  /* Fusion des doublons : repasser trois fois sur le même caillou en dix
   * minutes ne doit pas produire trois sondes empilées qui se disputent. */
  const near = list.findIndex((x) => distance(x, s) < MERGE_M);
  if (near >= 0) list[near] = { ...s, id: list[near].id };
  else list.push(s);

  await persist();
  return s;
}

export async function remove(id) {
  list = list.filter((s) => s.id !== id);
  await persist();
}

export async function clear() {
  list = [];
  await persist();
}

/** Défait le dernier relevé — le geste qu'on cherche après une faute de frappe. */
export async function undo() {
  if (!list.length) return null;
  const gone = list.reduce((a, b) => (b.t > a.t ? b : a));
  list = list.filter((s) => s.id !== gone.id);
  await persist();
  return gone;
}

/* ==========================================================================
 * Lire le carnet
 * ========================================================================== */

/** Les sondes dans un rayon, de la plus proche à la plus lointaine. */
export function near(lat, lon, radiusM = 400) {
  const p = { lat, lon };
  return list
    .map((s) => ({ ...s, distanceM: distance(p, s) }))
    .filter((s) => s.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Les sondes dans un rectangle — ce que la carte demande pour dessiner. */
export function inBounds(south, west, north, east) {
  return list.filter((s) => s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east);
}

/**
 * Sonde estimée au zéro des cartes, par pondération inverse de la distance.
 *
 * Pourquoi pas la plus proche seule : deux sondes à quinze et vingt mètres du
 * point qui disent 12 et 18 m décrivent un TALUS, et rendre 12 parce qu'elle
 * est la plus proche fait croire à un plateau. La moyenne pondérée rend 14 et
 * l'écart est rendu à part, pour que l'appelant sache qu'il est sur une pente.
 *
 * @returns {{zeroM:number, spreadM:number, n:number, distanceM:number}|null}
 */
export function depthAt(lat, lon, radiusM = 150) {
  const found = near(lat, lon, radiusM).filter((s) => s.zeroM != null);
  if (!found.length) return null;

  let wsum = 0;
  let vsum = 0;
  for (const s of found) {
    // +1 au dénominateur : une sonde pile sur le point ne doit pas diviser par
    // zéro, et le mètre de bruit GPS rend l'écart des tout petits rayons faux.
    const w = 1 / (s.distanceM + 1);
    wsum += w;
    vsum += w * s.zeroM;
  }
  const zs = found.map((s) => s.zeroM);
  return {
    zeroM: +(vsum / wsum).toFixed(1),
    spreadM: +(Math.max(...zs) - Math.min(...zs)).toFixed(1),
    n: found.length,
    distanceM: Math.round(found[0].distanceM),
  };
}

/**
 * Hauteur d'eau attendue sur ce point à un instant donné — la question qu'on
 * se pose vraiment avant de passer : « est-ce que ça passe à 7 h ? »
 */
export function waterAt(lat, lon, t = Date.now(), radiusM = 150) {
  const d = depthAt(lat, lon, radiusM);
  if (!d) return null;
  return { ...d, waterM: +(d.zeroM + tide.height(t)).toFixed(1), t };
}

/**
 * Le relief lu dans le carnet : l'écart entre la sonde la plus faible et la
 * plus forte du voisinage. C'est ce chiffre qui dit « il y a un ridin ici »,
 * et il n'a de sens qu'au-dessus d'une poignée de relevés.
 */
export function relief(lat, lon, radiusM = 500) {
  const found = near(lat, lon, radiusM).filter((s) => s.zeroM != null);
  if (found.length < 3) return null;
  const zs = found.map((s) => s.zeroM);
  const min = Math.min(...zs);
  const max = Math.max(...zs);
  return {
    reliefM: +(max - min).toFixed(1),
    shallowM: min,
    deepM: max,
    n: found.length,
    // Le sommet du ridin : là où l'on veut passer le leurre.
    crest: found.find((s) => s.zeroM === min) || null,
  };
}

/* ==========================================================================
 * État du carnet
 * ========================================================================== */
export function stats() {
  if (!list.length) return { n: 0 };
  const zs = list.filter((s) => s.zeroM != null).map((s) => s.zeroM);
  const ts = list.map((s) => s.t);
  return {
    n: list.length,
    corrigées: zs.length,
    minM: zs.length ? Math.min(...zs) : null,
    maxM: zs.length ? Math.max(...zs) : null,
    depuis: Math.min(...ts),
    derniere: Math.max(...ts),
  };
}

/* ==========================================================================
 * Sortir les sondes de l'app
 * --------------------------------------------------------------------------
 * Un carnet de sondes qu'on ne peut pas emporter ailleurs est un carnet qu'on
 * finit par perdre. Deux formats : GPX pour un traceur ou OpenCPN, CSV pour
 * un tableur ou un logiciel de cartographie.
 * ========================================================================== */

export function toGPX() {
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const pts = list.map((s) => {
    const d = s.zeroM ?? s.rawM;
    return `  <wpt lat="${s.lat}" lon="${s.lon}">\n`
      + `    <name>${d} m</name>\n`
      + `    <desc>${esc(`sonde ${s.rawM} m, marée ${s.tideM ?? '—'} m, ${new Date(s.t).toISOString()}`
        + (s.note ? ` — ${s.note}` : ''))}</desc>\n`
      + `    <time>${new Date(s.t).toISOString()}</time>\n`
      + '    <sym>Depth</sym>\n  </wpt>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="Grim\'s Compagnon" xmlns="http://www.topografix.com/GPX/1/1">\n'
    + `${pts}\n</gpx>\n`;
}

export function toCSV() {
  const head = 'lat,lon,sonde_brute_m,hauteur_maree_m,sonde_zero_cartes_m,precision_gps_m,confiance_maree,horodatage,note';
  const rows = list.map((s) => [
    s.lat, s.lon, s.rawM, s.tideM ?? '', s.zeroM ?? '', s.accuracyM ?? '',
    s.tideTrust, new Date(s.t).toISOString(), `"${(s.note || '').replace(/"/g, '""')}"`,
  ].join(','));
  return [head, ...rows].join('\n');
}

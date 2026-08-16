/* ==========================================================================
 * data/shomchart.js — la carte marine officielle du SHOM
 * --------------------------------------------------------------------------
 * Le SHOM diffuse ses cartes marines en tuiles WMTS : sondes, isobathes,
 * nature du fond, balisage, dangers. C'est la carte de référence française, et
 * c'est ce qu'on cherche quand on regarde une app de navigation commerciale.
 *
 * ── POURQUOI UNE CLÉ, ET POURQUOI ELLE N'EST PAS DANS LE CODE ─────────────
 * L'accès demande une clé, obtenue en s'inscrivant sur data.shom.fr. Elle est
 * PERSONNELLE : elle identifie son porteur et engage sa licence. Embarquer une
 * clé dans une app publique, c'est la donner à tout le monde et se la faire
 * révoquer dans la semaine. Elle vit donc dans l'appareil, saisie une fois.
 *
 * ── ON NE DEVINE PAS LES NOMS DE COUCHES ──────────────────────────────────
 * Le premier réflexe serait d'écrire « RASTER_MARINE » en dur. C'est la faute
 * qui a déjà coûté un aller-retour sur la bathymétrie : les identifiants d'un
 * service changent avec ses millésimes, et un nom périmé donne une carte vide
 * sans dire pourquoi. On lit donc GetCapabilities — le service DÉCLARE ce
 * qu'il sert, avec ses formats, ses styles et ses matrices — et l'utilisateur
 * choisit dans une liste réelle.
 *
 * ── LA LICENCE, ET CE QU'ELLE INTERDIT ────────────────────────────────────
 * La diffusion SHOM exclut expressément l'exploitation commerciale. Tant que
 * l'app est gratuite et sans publicité, l'usage est couvert ; le jour où elle
 * se vend, il faut une licence commerciale.
 *
 * La mise en cache hors ligne, elle, dépend des conditions attachées à la clé,
 * et personne ici ne peut les lire à la place de l'utilisateur. Elle est donc
 * ÉTEINTE PAR DÉFAUT, avec l'explication à l'écran. On ne conserve pas sur le
 * disque de quelqu'un une donnée sous licence sans qu'il l'ait décidé.
 *
 * ── CE QUE ÇA NE CHANGE PAS ───────────────────────────────────────────────
 * La carte officielle ne remplace pas les documents papier du bord, et elle ne
 * remplace pas non plus le reste de l'app hors réseau : sans cache, elle
 * disparaît dès qu'on perd la 4G. Le fond OSM, le balisage OpenSeaMap, le
 * modèle de fonds et le carnet de sondes restent là. C'est un plus, pas un
 * socle.
 * ========================================================================== */

import * as idb from '../core/idb.js';
import { emit } from '../core/store.js';

const KEY = 'shomChart';

/* Les deux points d'entrée connus. Le premier est celui d'une clé nominative,
 * le second le service INSPIRE. On essaie les deux plutôt que d'imposer à
 * l'utilisateur de savoir lequel lui a été attribué. */
export const ENDPOINTS = [
  (key) => `https://services.data.shom.fr/${encodeURIComponent(key)}/wmts`,
  () => 'https://services.data.shom.fr/INSPIRE/wmts',
];

/* Ce qui ressemble à une carte marine dans une liste de couches. Sert à
 * PROPOSER en tête de liste, jamais à filtrer : si le service publie une
 * couche au nom inattendu, elle doit rester choisissable. */
const PREFERRED = /raster|marine|carte|scan|nautical/i;

let cfg = null;

/* ==========================================================================
 * Réglage persistant
 * ========================================================================== */
export async function init() {
  cfg = (await idb.get('kv', KEY)) || null;
  return cfg;
}

export const config = () => (cfg ? { ...cfg } : null);
export const ready = () => !!(cfg?.key && cfg?.layer && cfg?.template);

export async function save(next) {
  cfg = next ? { ...cfg, ...next } : null;
  if (cfg) await idb.put('kv', KEY, cfg);
  else await idb.del('kv', KEY);
  emit('shom:changed', config());
  return config();
}

export const forget = () => save(null);

/* ==========================================================================
 * Interrogation du service
 * ========================================================================== */

/**
 * Demande au service ce qu'il sait servir.
 *
 * @param {string} key La clé personnelle.
 * @returns {Promise<{endpoint:string, layers:Array, error?:string}>}
 */
export async function discover(key) {
  const tried = [];
  for (const build of ENDPOINTS) {
    const base = build(key);
    const url = `${base}?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) {
        tried.push(`${base} → HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const layers = parseCapabilities(xml, base);
      if (!layers.length) {
        tried.push(`${base} → réponse sans couche exploitable`);
        continue;
      }
      return { endpoint: base, layers };
    } catch (e) {
      tried.push(`${base} → ${e?.message || 'injoignable'}`);
    }
  }
  return { endpoint: null, layers: [], error: tried.join(' · ') };
}

/**
 * Lit un GetCapabilities WMTS.
 *
 * Les espaces de noms varient d'un serveur à l'autre — `wmts:`, `ows:`, ou
 * rien du tout. On interroge donc par NOM LOCAL, ce qui évite de dépendre du
 * préfixe choisi par le producteur.
 *
 * @returns {Array<{id, title, format, style, matrixSet, matrixIds, template}>}
 */
export function parseCapabilities(xml, base) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];

  const local = (node, name) => [...node.getElementsByTagNameNS('*', name)];
  const textOf = (node, name) => local(node, name)[0]?.textContent?.trim() || '';

  /* Les matrices : chaque jeu déclare ses propres identifiants de niveau.
   * Certains services numérotent « 0, 1, 2 », d'autres « EPSG:3857:0 ». Écrire
   * `{z}` en dur marche chez les uns et donne un 400 chez les autres — d'où la
   * table, lue une fois et embarquée dans le réglage. */
  const sets = {};
  for (const ms of local(doc, 'TileMatrixSet')) {
    // Un TileMatrixSetLink porte aussi ce nom : on ne garde que ceux qui
    // contiennent réellement des matrices.
    const mats = local(ms, 'TileMatrix');
    if (!mats.length) continue;
    const id = local(ms, 'Identifier')[0]?.textContent?.trim();
    if (!id) continue;
    sets[id] = mats
      .map((m) => local(m, 'Identifier')[0]?.textContent?.trim())
      .filter(Boolean);
  }

  const out = [];
  for (const layer of local(doc, 'Layer')) {
    const id = local(layer, 'Identifier')[0]?.textContent?.trim();
    if (!id) continue;
    const title = textOf(layer, 'Title') || id;

    const formats = local(layer, 'Format').map((f) => f.textContent.trim());
    const format = formats.find((f) => /png/i.test(f)) || formats.find((f) => /jpe?g/i.test(f)) || formats[0] || 'image/png';

    const styleEl = local(layer, 'Style').find((s) => s.getAttribute('isDefault') === 'true')
      || local(layer, 'Style')[0];
    const style = styleEl ? local(styleEl, 'Identifier')[0]?.textContent?.trim() || 'normal' : 'normal';

    // On ne retient que le Web Mercator : c'est la projection de Leaflet, et
    // reprojeter des tuiles dans le navigateur n'a pas de sens ici.
    const links = local(layer, 'TileMatrixSetLink')
      .map((l) => local(l, 'TileMatrixSet')[0]?.textContent?.trim())
      .filter(Boolean);
    const matrixSet = links.find((s) => /3857|mercator|googlemaps/i.test(s));
    if (!matrixSet) continue;

    /* Le service peut fournir un gabarit d'URL tout fait (ResourceURL). Quand
     * il est là on le prend : c'est la forme que le producteur garantit. */
    const rurl = local(layer, 'ResourceURL')
      .find((r) => r.getAttribute('resourceType') === 'tile'
        && (!format || r.getAttribute('format') === format))
      || local(layer, 'ResourceURL').find((r) => r.getAttribute('resourceType') === 'tile');

    const template = rurl?.getAttribute('template') || kvpTemplate(base, id, style, matrixSet, format);

    out.push({
      id,
      title,
      format,
      style,
      matrixSet,
      matrixIds: sets[matrixSet] || [],
      template,
      preferred: PREFERRED.test(`${id} ${title}`),
    });
  }

  // Les couches qui ressemblent à une carte marine d'abord : la liste d'un
  // service national fait parfois cinquante entrées.
  out.sort((a, b) => (b.preferred - a.preferred) || a.title.localeCompare(b.title, 'fr'));
  return out;
}

/** Gabarit d'URL en mode clé-valeur, quand le service n'en fournit pas. */
function kvpTemplate(base, layer, style, matrixSet, format) {
  return `${base}?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile`
    + `&LAYER=${encodeURIComponent(layer)}&STYLE=${encodeURIComponent(style)}`
    + `&TILEMATRIXSET=${encodeURIComponent(matrixSet)}`
    + '&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}'
    + `&FORMAT=${encodeURIComponent(format)}`;
}

/* ==========================================================================
 * L'URL que Leaflet comprend
 * ========================================================================== */

/**
 * Transforme le gabarit WMTS en gabarit Leaflet.
 *
 * WMTS parle de {TileMatrix}/{TileRow}/{TileCol}, Leaflet de {z}/{y}/{x}. La
 * seule subtilité est le niveau : quand le service numérote ses matrices
 * « EPSG:3857:11 », il faut envoyer cette chaîne-là et pas « 11 ». On garde la
 * table des identifiants et on la consulte à la volée.
 */
export function leafletUrl(conf = cfg) {
  if (!conf?.template) return null;
  let t = conf.template
    .replace(/\{TileRow\}/gi, '{y}')
    .replace(/\{TileCol\}/gi, '{x}')
    .replace(/\{Style\}/gi, conf.style || 'normal')
    .replace(/\{TileMatrixSet\}/gi, conf.matrixSet || '')
    .replace(/\{layer\}/gi, conf.layer || '');
  // Le niveau : si les identifiants sont préfixés, Leaflet ne saura pas le
  // fabriquer seul. On lui donne un gabarit avec le préfixe et il n'a plus
  // qu'à substituer le nombre.
  const ids = conf.matrixIds || [];
  const sample = ids.find((x) => /\D/.test(x));
  if (sample) {
    const prefix = sample.replace(/\d+$/, '');
    t = t.replace(/\{TileMatrix\}/gi, `${prefix}{z}`);
  } else {
    t = t.replace(/\{TileMatrix\}/gi, '{z}');
  }
  return t;
}

/** Les niveaux de zoom réellement servis, déduits de la table des matrices. */
export function zoomRange(conf = cfg) {
  /* Le numéro de niveau est le nombre de FIN, pas le premier rencontré :
   * « EPSG:3857:14 » vaut 14, et retirer seulement les lettres de tête laissait
   * « 3857:14 », donc NaN, donc le repli — avec un maxNativeZoom de 18 pour un
   * service qui s'arrête à 17. La carte blanchissait au dernier cran de zoom,
   * ce que le repli était justement censé empêcher. */
  const nums = (conf?.matrixIds || [])
    .map((x) => Number(String(x).match(/(\d+)\s*$/)?.[1]))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return { min: 2, max: 18 };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

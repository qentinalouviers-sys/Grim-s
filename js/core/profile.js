/* ==========================================================================
 * core/profile.js — identité du bateau
 * --------------------------------------------------------------------------
 * Le bateau est l'identité de cette app : c'est lui qui appelle à la VHF, lui
 * qui pose des marques, lui qui déclarera ses prises à la communauté. Pas
 * l'utilisateur — sur l'eau, on s'annonce par le nom du bateau.
 *
 * Ce module porte donc le futur COMPTE, mais il tourne aujourd'hui entièrement
 * en local :
 *
 *   nom du bateau     déjà utilisé par le message MAYDAY de l'écran SOS
 *   coque, taille,    déterminent ce qui est prudent : une mer de 1,2 m ne
 *   motorisation      veut pas dire la même chose sous un semi-rigide de 5 m
 *                     et sous une coque dure de 8 m
 *   types de pêche    orientent le conseil et, demain, ce qu'on partage
 *
 * ── SUR LE MOT DE PASSE ───────────────────────────────────────────────────
 * Il n'y en a PAS ici, et c'est délibéré. Un mot de passe stocké sur l'appareil
 * ne protège rien : il n'y a aucun serveur à qui le prouver, et n'importe quel
 * outil de développement le lit en clair dans IndexedDB. Un champ « mot de
 * passe » qui ne fait rien est pire qu'aucun champ — il fabrique une confiance
 * fausse, et les gens y mettent le mot de passe qu'ils utilisent ailleurs.
 *
 * Le jour où un serveur existe, c'est LUI qui vérifie le mot de passe, et le
 * profil ci-dessous devient le corps du compte. La forme est déjà prête pour
 * ça : un identifiant stable dérivé du nom, une date de création, un numéro de
 * version pour la migration.
 * ========================================================================== */

import { state, set, emit } from './store.js';
import * as idb from './idb.js';

export const HULL_TYPES = [
  { id: 'coque-dure', name: 'Coque dure', hint: 'Plus sèche, plus lourde, tient mieux la mer formée.' },
  { id: 'semi-rigide', name: 'Semi-rigide', hint: 'Plus vive et plus tapante : le clapot se ressent davantage.' },
  { id: 'pneumatique', name: 'Pneumatique', hint: 'Léger, très sensible au vent et au clapot court.' },
  { id: 'voilier', name: 'Voilier', hint: 'Dérive et gîte : le fardage change tout le calcul.' },
];

export const PROPULSIONS = [
  { id: 'hb-2t', name: 'Hors-bord 2T' },
  { id: 'hb-4t', name: 'Hors-bord 4T' },
  { id: 'in-board', name: 'In-board / diesel' },
  { id: 'electrique', name: 'Électrique' },
  { id: 'voile', name: 'Voile' },
];

export const FISHING_TYPES = [
  { id: 'leurre', name: 'Pêche aux leurres' },
  { id: 'peche-a-soutenir', name: 'Pêche à soutenir / appâts' },
  { id: 'traine', name: 'Traîne' },
  { id: 'derive', name: 'Dérive sur épave / ridin' },
  { id: 'palangre', name: 'Palangre / lignes de fond' },
  { id: 'casier', name: 'Casiers' },
  { id: 'turlutte', name: 'Turlutte (seiche, encornet)' },
  { id: 'plats', name: 'Poissons plats au ver' },
];

const EMPTY = {
  version: 1,
  id: null,
  boatName: '',
  /* Immatriculation portée sur la coque — « DP 123456 » dans le quartier de
   * Dieppe. C'est elle que demandent les affaires maritimes et le CROSS quand
   * ils cherchent à identifier un bateau signalé. */
  immat: '',
  /* MMSI : les neuf chiffres de la VHF ASN. S'il est renseigné, un appel de
   * détresse numérique porte l'identité du bateau sans que personne ait à
   * parler — ce qui compte quand on n'a plus les mains libres. */
  mmsi: '',
  hull: null,
  lengthM: null,
  propulsion: null,
  powerHp: null,
  pob: null,
  fishing: [],
  createdAt: null,
  updatedAt: null,
};

/** Identifiant stable dérivé du nom : c'est lui qui deviendra la clé du compte. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export const get = () => state.profile || { ...EMPTY };

/** Le profil est-il assez rempli pour servir — MAYDAY compris ? */
export const isComplete = (p = get()) => !!(p.boatName && p.hull && p.lengthM);

export async function init() {
  const saved = (await idb.get('kv', 'profile')) || null;
  // Reprise de l'existant : le nom du bateau et l'équipage vivaient dans les
  // réglages depuis l'écran SOS. On ne les redemande pas.
  const settings = state.settings || {};
  const merged = saved || {
    ...EMPTY,
    boatName: settings.boatName || '',
    pob: settings.pob || null,
  };
  set({ profile: merged });
  return merged;
}

export async function save(patch) {
  const now = Date.now();
  const prev = get();
  const next = {
    ...prev,
    ...patch,
    version: 1,
    updatedAt: now,
    createdAt: prev.createdAt || now,
  };
  next.id = next.id || (next.boatName ? `${slugify(next.boatName)}-${now.toString(36)}` : null);
  set({ profile: next });
  await idb.put('kv', 'profile', next);

  // Le nom du bateau, l'équipage et les identifiants restent aussi dans les
  // réglages : l'écran SOS les lit là, et il ne doit dépendre de rien qui
  // puisse manquer au moment où on en a besoin.
  const settings = {
    ...(state.settings || {}),
    boatName: next.boatName,
    pob: next.pob,
    immat: next.immat,
    mmsi: next.mmsi,
    updatedAt: now,
  };
  set({ settings });
  await idb.put('kv', 'settings', settings);

  emit('profile:changed', next);
  return next;
}

/**
 * Ce que le profil change dans les conseils, aujourd'hui, sans serveur.
 * Un semi-rigide de 5 m et une coque dure de 8 m n'ont pas la même limite de
 * mer, et l'app n'a aucune raison de leur dire la même chose.
 * @returns {{seaLimitM:number, windLimitKn:number, label:string}}
 */
export function comfort(p = get()) {
  const len = p.lengthM || 6;
  const hull = p.hull || 'coque-dure';
  // Base : la mer significative qu'on encaisse sans que la sortie tourne à
  // l'épreuve. Croît avec la longueur, pénalisée sur les carènes légères.
  const hullFactor = hull === 'semi-rigide' ? 0.85 : hull === 'pneumatique' ? 0.7 : 1;
  const seaLimitM = Math.round((0.18 * len + 0.15) * hullFactor * 10) / 10;
  const windLimitKn = Math.round((2.2 * len + 4) * hullFactor);
  return {
    seaLimitM,
    windLimitKn,
    label: `${p.boatName || 'Bateau'} · ${len} m · mer ≤ ${seaLimitM} m, vent ≤ ${windLimitKn} nd`,
  };
}

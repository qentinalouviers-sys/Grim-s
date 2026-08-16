/* ==========================================================================
 * ui/lurebox.js — la boîte à leurres
 * --------------------------------------------------------------------------
 * Deux façons de renseigner la même chose, parce que les deux ont leur moment :
 *
 *   AU DOIGT   six pastilles de ciel, cinq d'eau. Deux taps, gants compris.
 *              C'est le chemin par défaut, et il marche sans autorisation,
 *              sans réseau et sans batterie de caméra.
 *
 *   À L'ŒIL    on vise l'eau par-dessus le liston, on appuie. L'app moyenne le
 *              centre de l'image et classe la teinte. Décrire une couleur
 *              d'eau avec des mots est un exercice où deux pêcheurs ne tombent
 *              jamais d'accord ; un capteur, lui, mesure. Surtout pour la craie
 *              du pays de Caux, que l'œil appelle « pas très sale » alors que
 *              la visibilité y est de moins d'un mètre.
 *
 * Le résultat n'est jamais « mets ça ». C'est trois couleurs classées, la
 * raison de chaque classement, et le paragraphe qu'on lit à voix haute.
 * ========================================================================== */

import { state } from '../core/store.js';
import { el, clear, button, toast, openSheet, closeSheet } from './dom.js';
import * as lures from '../fishing/lures.js';
import * as weather from '../data/weather.js';
import * as stream from '../data/stream.js';
import { sunAltitude } from '../data/astro.js';
import * as spots from '../fishing/spots.js';
import * as depth from '../data/depth.js';
import * as idb from '../core/idb.js';

// L'état survit à la fermeture de la feuille : on rouvre la boîte dix fois
// dans une sortie, et refaire deux taps à chaque fois est une punition.
let choice = null;

/** Contexte déduit de ce que l'app sait déjà, au moment où on ouvre. */
function autoContext() {
  const now = Date.now();
  const pos = state.fix || spots.getPort();
  const hourly = state.weather?.hourly || [];
  const wx = hourly.length ? weather.interp(hourly, now) : null;
  const turb = hourly.length ? weather.turbidity(hourly, now, state.tideNow?.coefficient ?? 70) : null;
  const sunAlt = sunAltitude(new Date(now), pos.lat, pos.lon);

  const depthM = depth.meters(pos.lat, pos.lon);
  const st = stream.tidalStream(now, pos);

  return {
    guess: lures.guess({
      cloudCover: wx?.cloudCover ?? null,
      turbidity: turb,
      sunAltDeg: sunAlt,
    }),
    depthM: Number.isFinite(depthM) && depthM > 1 ? Math.round(depthM) : 12,
    depthKnown: Number.isFinite(depthM) && depthM > 1,
    // `spd`, pas `speedKn` — même faute que dans live.js, et elle faisait
    // calculer toutes les plombées à 1 nœud quel que soit le courant réel.
    currentKn: Number.isFinite(st?.spd) ? Math.round(st.spd * 10) / 10 : 1,
    turbidity: turb,
    cloudCover: wx?.cloudCover ?? null,
  };
}

export async function openLureBox(opts = {}) {
  const ctx = autoContext();
  if (!choice) {
    const saved = await idb.get('kv', 'lureChoice');
    choice = saved || {};
  }
  const cur = {
    skyId: choice.skyId || ctx.guess.skyId,
    waterId: choice.waterId || ctx.guess.waterId,
    depthM: opts.depthM ?? choice.depthM ?? ctx.depthM,
    currentKn: opts.currentKn ?? ctx.currentKn,
    fromPhoto: choice.fromPhoto || null,
  };

  const body = el('div');
  const out = el('div');

  /* ── Ciel ─────────────────────────────────────────────────────────── */
  body.append(sectionTitle('LE CIEL', ctx.cloudCover != null ? `${Math.round(ctx.cloudCover)} % de nuages` : null));
  const skyRow = swatchRow(lures.SKIES, cur.skyId, (id) => {
    cur.skyId = id;
    cur.fromPhoto = null;
    persist(cur);
    paint();
  });
  body.append(skyRow.node);

  /* ── Eau ──────────────────────────────────────────────────────────── */
  body.append(sectionTitle("L’EAU", ctx.turbidity != null ? `turbidité estimée ${Math.round(ctx.turbidity * 100)} %` : null));
  const waterRow = swatchRow(lures.WATERS, cur.waterId, (id) => {
    cur.waterId = id;
    cur.fromPhoto = null;
    persist(cur);
    paint();
  });
  body.append(waterRow.node);

  const camRow = el('div', 'row');
  camRow.style.marginTop = '8px';
  const camBtn = button('📷 Lire la couleur de l’eau', 'btn-sm', () => openCamera('water', (res) => {
    cur.waterId = res.water.id;
    cur.fromPhoto = res;
    persist(cur);
    paint();
    toast(`Eau lue : ${res.water.name.toLowerCase()}`, 'good');
  }));
  const camSky = button('📷 Le ciel', 'btn-sm', () => openCamera('sky', (res) => {
    cur.skyId = res.sky.id;
    persist(cur);
    paint();
    toast(`Ciel lu : ${res.sky.name.toLowerCase()}`, 'good');
  }));
  camRow.append(camBtn, camSky);
  body.append(camRow);
  body.append(el('p', 'tiny',
    'Vise l’eau par-dessus le liston, sans reflet du ciel ni écume dans le viseur. La photo n’est ni gardée ni envoyée : seule la moyenne des couleurs est lue, puis jetée.'));

  /* ── Sonde et courant ─────────────────────────────────────────────── */
  body.append(sectionTitle('OÙ TU PÊCHES', null));
  const depthRow = el('div', 'row');
  depthRow.style.alignItems = 'center';
  const depthLbl = el('span', 'tnum');
  depthLbl.style.minWidth = '58px';
  depthLbl.style.fontWeight = '750';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '2';
  slider.max = '50';
  slider.step = '1';
  slider.value = String(cur.depthM);
  slider.style.flex = '1';
  slider.addEventListener('input', () => {
    cur.depthM = Number(slider.value);
    persist(cur);
    paint();
  });
  depthRow.append(el('span', 'tiny', 'Sonde'), slider, depthLbl);
  body.append(depthRow);
  const depthNote = el('div', 'tiny');
  body.append(depthNote);

  body.append(out);
  openSheet('🎨 Quel leurre ?', body);

  function paint() {
    depthLbl.textContent = `${cur.depthM} m`;
    depthNote.textContent = ctx.depthKnown
      ? `Sonde EMODnet sous ta position : ${ctx.depthM} m. Ajuste si tu vises autre chose.`
      : 'Pas de sonde connue ici : règle à la main ou fie-toi au sondeur.';
    skyRow.select(cur.skyId);
    waterRow.select(cur.waterId);
    renderResult(out, cur, ctx);
  }
  paint();
}

function persist(cur) {
  choice = { ...cur };
  idb.put('kv', 'lureChoice', { skyId: cur.skyId, waterId: cur.waterId, depthM: cur.depthM });
}

/* --------------------------------------------------------------------------
 * Pastilles de couleur
 * ------------------------------------------------------------------------ */
function sectionTitle(text, hint) {
  const r = el('div', 'card-head');
  r.style.marginTop = '12px';
  r.append(el('h3', null, text), el('div', 'spacer'));
  if (hint) r.append(el('span', 'tiny', hint));
  return r;
}

function swatchRow(items, selectedId, onPick) {
  const node = el('div', 'swatch-row');
  const btns = new Map();
  for (const it of items) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.setAttribute('aria-label', it.name);
    const dot = el('span', 'swatch-dot');
    dot.style.background = it.swatch;
    b.append(dot, el('span', 'swatch-lbl', it.name));
    b.addEventListener('click', () => onPick(it.id));
    btns.set(it.id, b);
    node.append(b);
  }
  const select = (id) => {
    for (const [k, b] of btns) b.classList.toggle('on', k === id);
  };
  select(selectedId);
  return { node, select };
}

/* --------------------------------------------------------------------------
 * Résultat
 * ------------------------------------------------------------------------ */
function renderResult(box, cur, ctx) {
  clear(box);
  const cond = lures.conditions(cur);
  const top = lures.rank(cond);
  const fam = lures.family(cond);
  const rig = lures.rigWeight(cur.depthM, cur.currentKn);

  /* La réponse d'abord, en grand : c'est pour ça qu'on a ouvert l'écran. */
  const hero = el('div', 'card');
  hero.style.marginTop = '14px';
  for (const r of top) {
    const row = el('div', 'lure-row');
    if (r.rank === 1) row.classList.add('first');
    const chip = el('div', 'lure-chip');
    chip.style.background = `linear-gradient(140deg, ${r.colour.hex} 0%, ${r.colour.hex} 48%, ${r.colour.hex2} 52%, ${r.colour.hex2} 100%)`;
    const main = el('div', 'list-main');
    main.append(el('div', 'list-title', `${r.rank}. ${r.colour.name}`));
    main.append(el('div', 'list-sub', r.colour.note));
    main.append(el('div', 'tiny', `Ce qui la classe ici : ${r.driver.label}.`));
    row.append(chip, main);
    hero.append(row);
  }
  /* Pas de note sur cent : « 58/100 » pour un coloris ne veut rien dire et
   * donne à un classement relatif l'air d'une mesure. Ce qui est utile, c'est
   * de savoir si le choix est TRANCHÉ — auquel cas on insiste — ou serré,
   * auquel cas on change au bout d'un quart d'heure au lieu de s'entêter. */
  const gap = top.length > 1 ? top[0].score - top[1].score : 1;
  hero.append(el('div', 'tiny', gap < 0.04
    ? 'Choix serré : le deuxième vaut le premier. Si rien n’a touché en quinze minutes, change de coloris avant de changer de poste.'
    : 'Écart net entre le premier et les suivants : insiste avec celui-là avant d’en changer.'));
  box.append(hero);

  /* Le paragraphe qu'on lit à voix haute. */
  const why = el('div', 'card');
  const wh = el('div', 'card-head');
  wh.append(el('h3', null, 'POURQUOI'));
  why.append(wh, el('p', 'muted', lures.verdict(cond, top)));
  box.append(why);

  /* Le montage. */
  const rigCard = el('div', 'card');
  const rh = el('div', 'card-head');
  rh.append(el('h3', null, 'LE MONTAGE'));
  rigCard.append(rh);
  rigCard.append(el('div', 'list-title', fam.name));
  rigCard.append(el('div', 'list-sub', fam.why));

  const strip = el('div', 'strip');
  strip.style.marginTop = '10px';
  strip.append(pill(`${rig.grams} g`, 'PLOMBÉE'));
  strip.append(pill(`${cond.visibilityM.toFixed(1)} m`, 'VISIBILITÉ'));
  strip.append(pill(`${Math.round(cond.lightAtDepth * 100)} %`, `LUMIÈRE À ${cur.depthM} M`));
  strip.append(pill(`${cur.currentKn} nd`, 'COURANT'));
  rigCard.append(strip);
  rigCard.append(el('div', 'tiny',
    `Calcul de la plombée : ${rig.raw} g théoriques pour ${cur.depthM} m à ${cur.currentKn} nd, arrondis à une taille qui existe en boîte. Passe à ${rig.alt} g si la bannière part à l’horizontale.`));
  box.append(rigCard);

  if (cur.fromPhoto) {
    const p = cur.fromPhoto;
    const conf = Math.round((p.confidence || 0) * 100);
    box.append(el('p', 'tiny',
      `Lecture photo : R${p.sample.r} V${p.sample.g} B${p.sample.b} — teinte ${Math.round(p.sample.h)}°, saturation ${Math.round(p.sample.s * 100)} %, clarté ${Math.round(p.sample.l * 100)} %. Confiance ${conf} %.${conf < 40 ? ' Faible : corrige à la main si ça ne colle pas.' : ''}`));
  }
}

function pill(val, lbl) {
  const p = el('div', 'pill');
  p.style.minWidth = '84px';
  p.append(el('div', 'pill-val', val), el('div', 'pill-lbl', lbl));
  return p;
}

/* --------------------------------------------------------------------------
 * Appareil photo
 * --------------------------------------------------------------------------
 * Flux vidéo en direct plutôt que capture de fichier : on voit ce qu'on vise,
 * et surtout on ne fabrique aucun fichier. Rien n'est enregistré, rien n'est
 * envoyé — la seule chose qui sort de cette fonction est une moyenne de trois
 * octets. Le flux est coupé dans tous les cas de sortie, y compris l'erreur :
 * une caméra qui reste allumée en poche vide une batterie en une heure.
 * ------------------------------------------------------------------------ */
async function openCamera(kind, onResult) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return void toast('Pas d’appareil photo accessible ici', 'danger');
  }
  let stream_ = null;
  const body = el('div');
  const shell = el('div', 'cam-shell');
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  shell.append(video, el('div', 'cam-target'));
  body.append(shell);
  body.append(el('p', 'tiny', kind === 'water'
    ? 'Cadre l’eau dans le carré, sans reflet du ciel ni écume. Reste à un mètre du bord.'
    : 'Pointe le carré vers le ciel, à l’opposé du soleil.'));

  const shoot = button('Lire la couleur', 'btn-primary btn-lg', () => {
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth || 640;
      c.height = video.videoHeight || 480;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      const sample = lures.sampleCanvas(c);
      const res = kind === 'water' ? lures.classifyWater(sample) : lures.classifySky(sample);
      stop();
      closeSheet();
      onResult({ ...res, sample });
    } catch (e) {
      toast('Lecture impossible', 'danger');
    }
  });
  shoot.style.marginTop = '10px';
  body.append(shoot);

  const stop = () => {
    for (const t of stream_?.getTracks() || []) t.stop();
    stream_ = null;
  };

  openSheet(kind === 'water' ? 'Couleur de l’eau' : 'Couleur du ciel', body, stop);

  try {
    stream_ = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    video.srcObject = stream_;
  } catch (e) {
    stop();
    closeSheet();
    toast('Autorisation appareil photo refusée', 'danger');
  }
}

/* --------------------------------------------------------------------------
 * Carte compacte pour la vue PÊCHE
 * ------------------------------------------------------------------------ */
export function card() {
  const ctx = autoContext();
  const cur = {
    skyId: choice?.skyId || ctx.guess.skyId,
    waterId: choice?.waterId || ctx.guess.waterId,
    depthM: choice?.depthM || ctx.depthM,
    currentKn: ctx.currentKn,
  };
  const cond = lures.conditions(cur);
  const top = lures.rank(cond, { limit: 3 });

  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.append(el('h3', null, 'BOÎTE À LEURRES'), el('div', 'spacer'));
  h.append(el('span', 'tiny', `${lures.sky(cur.skyId).emoji} ${lures.water(cur.waterId).emoji}`));
  c.append(h);

  const row = el('button', 'lure-row first');
  row.type = 'button';
  row.style.width = '100%';
  const chips = el('div', 'lure-trio');
  for (const r of top) {
    const d = el('span', 'lure-chip sm');
    d.style.background = `linear-gradient(140deg, ${r.colour.hex} 0%, ${r.colour.hex} 48%, ${r.colour.hex2} 52%, ${r.colour.hex2} 100%)`;
    chips.append(d);
  }
  const main = el('div', 'list-main');
  main.append(el('div', 'list-title', top[0].colour.name));
  main.append(el('div', 'list-sub',
    `${lures.family(cond).name} · ${lures.rigWeight(cur.depthM, cur.currentKn).grams} g · ${cur.depthM} m`));
  row.append(chips, main);
  row.addEventListener('click', () => openLureBox());
  c.append(row);
  c.append(el('div', 'tiny', 'Touche pour régler le ciel, l’eau et la sonde — ou les lire à l’appareil photo.'));
  return c;
}

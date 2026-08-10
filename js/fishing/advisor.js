/* ==========================================================================
 * fishing/advisor.js — le guide
 * --------------------------------------------------------------------------
 * Un score de 84/100 ne dit pas quoi faire. Ce module transforme le calcul en
 * DÉCISIONS formulées comme les formulerait quelqu'un qui connaît le coin :
 * quoi viser, où, à quelle heure, avec quoi, et ce qui va coincer.
 *
 * ── POURQUOI UN SYSTÈME EXPERT ET PAS UN LLM ──────────────────────────────
 * C'est un choix, pas un renoncement. Trois raisons, dans l'ordre :
 *
 *   1. Ça doit marcher SANS RÉSEAU. La recommandation est justement ce dont
 *      on a besoin au moment où on ne capte plus.
 *   2. Ça doit être GRATUIT et sans inscription — la contrainte posée.
 *   3. Un modèle de langage inventerait des heures de marée plausibles. Ici
 *      chaque phrase est adossée à une valeur calculée, traçable, et le
 *      facteur limitant est celui que le moteur a réellement identifié.
 *
 * La couche est conçue comme un générateur de texte à partir de faits
 * structurés (`facts` ci-dessous). Brancher un LLM en v2 pour reformuler ces
 * mêmes faits est un remplacement de la seule fonction narrate(), sans
 * toucher au raisonnement. C'est la bonne frontière.
 * ========================================================================== */

import { SPECIES_RULES, getRegulationStatus } from './species.js';
import { findWindows, ranking } from './engine.js';
import * as spots from './spots.js';
import * as weather from '../data/weather.js';
import { hhmm, hhmmDay, cardinal, num, dist, beaufort, beaufortLabel } from '../core/fmt.js';
import { moonPhase } from '../data/astro.js';

const HOUR = 3600000;

/**
 * Produit le briefing complet de la sortie.
 *
 * @returns {{
 *   headline: string,
 *   subline: string,
 *   plan: {t:number, until:number, speciesId:string, title:string, lines:string[], score:number, spot:object|null}[],
 *   warnings: {level:'info'|'warn'|'danger', text:string}[],
 *   conditions: {label:string, value:string}[],
 *   closed: string[]
 * }}
 */
export function brief({ now = Date.now(), samples = [], scores = {}, hourly = [], pos, tideInfo, sun }) {
  const wx = weather.interp(hourly, now);
  const sample = nearestSample(samples, now);
  const warnings = [];
  const conditions = [];

  /* ---- 1. Sécurité et faisabilité : ça passe avant la pêche -------------- */
  if (wx) {
    const bf = beaufort(wx.windSpeedKn);
    conditions.push({
      label: 'Vent',
      value: `${cardinal(wx.windDirDeg)} ${Math.round(wx.windSpeedKn)} nd (F${bf}${
        wx.windGustKn > wx.windSpeedKn + 5 ? `, raf. ${Math.round(wx.windGustKn)}` : ''
      })`,
    });
    if (bf >= 6) {
      warnings.push({ level: 'danger', text: `${beaufortLabel(bf)} annoncé — sortie déconseillée en petite unité.` });
    } else if (bf === 5) {
      warnings.push({ level: 'warn', text: 'Bonne brise : mer formée au large, reste sous la côte ou décale.' });
    }
    if (wx.windGustKn > wx.windSpeedKn * 1.6 && wx.windGustKn > 20) {
      warnings.push({ level: 'warn', text: `Rafales à ${Math.round(wx.windGustKn)} nd — régime instable, grains probables.` });
    }
    if (wx.visibilityM != null && wx.visibilityM < 2000) {
      warnings.push({
        level: wx.visibilityM < 800 ? 'danger' : 'warn',
        text: `Visibilité ${(wx.visibilityM / 1000).toFixed(1)} km — signaux sonores, radar/AIS, cap au compas.`,
      });
    }
    if (wx.waveHeightM != null) {
      conditions.push({ label: 'Mer', value: `${num(wx.waveHeightM, 1)} m${wx.wavePeriodS ? ` / ${Math.round(wx.wavePeriodS)} s` : ''}` });
      if (wx.waveHeightM >= 1.5) {
        warnings.push({ level: 'warn', text: `Mer à ${num(wx.waveHeightM, 1)} m : tenue de poste difficile, verticale peu précise.` });
      }
    }
    if (wx.seaTempC != null) conditions.push({ label: 'Eau', value: `${num(wx.seaTempC, 1)} °C` });
    if (wx.pressureHpa != null) {
      const trend = weather.pressureTrend6h(hourly, now);
      conditions.push({
        label: 'Pression',
        value: `${Math.round(wx.pressureHpa)} hPa${
          trend != null ? ` ${trend > 0.5 ? '↗' : trend < -0.5 ? '↘' : '→'} ${num(Math.abs(trend), 1)}/6h` : ''
        }`,
      });
      if (trend != null && trend < -3) {
        warnings.push({ level: 'warn', text: 'Chute barométrique marquée sur 6 h — dégradation en approche.' });
      }
    }
  } else {
    warnings.push({ level: 'info', text: 'Pas de météo à jour : scores calculés sur la marée seule, moins informés.' });
  }

  /* ---- 2. Marée et courant ---------------------------------------------- */
  if (sample) {
    conditions.push({ label: 'Coefficient', value: String(sample.coefficient) });
    conditions.push({
      label: 'Courant',
      value: `${num(sample.streamKn, 1)} nd ${cardinal(sample.streamDirDeg)} (${senseLabel(sample.tideSense)})`,
    });
    conditions.push({ label: 'Dérive bateau', value: `${num(sample.driftKn, 1)} nd ${cardinal(sample.driftDirDeg)}` });

    const wat = spots.windAgainstTide(sample.windDirDeg, sample.windSpeedKn, sample.streamDirDeg, sample.streamKn);
    if (wat.opposed) {
      warnings.push({
        level: wat.severity > 0.6 ? 'danger' : 'warn',
        text: `${wat.label}. Le clapot va se lever sans que la houle du modèle bouge — c'est le piège classique du secteur.`,
      });
    }
    if (sample.coefficient >= 100) {
      warnings.push({ level: 'info', text: `Coefficient ${sample.coefficient} : dérive rapide, plombées lourdes, fenêtres d'étale courtes.` });
    }
  }
  // Le caractère provisoire du modèle de marée est signalé une seule fois, par
  // le bandeau global de main.js. Le répéter ici le ferait apparaître deux fois
  // sur le même écran, et deux avertissements identiques se lisent comme du
  // bruit — donc ne se lisent plus.

  /* ---- 3. Lune et lumière ----------------------------------------------- */
  const moon = moonPhase(new Date(now));
  conditions.push({ label: 'Lune', value: `${moon.name} · ${Math.round(moon.illumination * 100)} %` });
  if (sun?.sunsetT) conditions.push({ label: 'Coucher', value: hhmm(sun.sunsetT) });

  /* ---- 4. Le plan -------------------------------------------------------- */
  const horizon = now + 14 * HOUR;
  const candidates = [];

  for (const id of Object.keys(scores)) {
    const reg = getRegulationStatus(id, now);
    if (reg.mode === 'closed') continue;
    for (const w of findWindows(scores[id], { minDurationMinutes: 45 })) {
      if (w.endT < now || w.startT > horizon) continue;
      candidates.push({ ...w, noKill: reg.mode === 'no-kill' });
    }
  }
  candidates.sort((a, b) => a.startT - b.startT);

  // On ne garde qu'une espèce par créneau : un plan de sortie, pas un catalogue.
  const plan = [];
  for (const w of candidates) {
    if (plan.some((p) => overlaps(p, w) && p.score >= w.peakScore)) continue;
    const conflict = plan.findIndex((p) => overlaps(p, w));
    const entry = buildPlanEntry(w, { hourly, pos, now });
    if (conflict >= 0) plan[conflict] = entry;
    else plan.push(entry);
    if (plan.length >= 4) break;
  }

  /* ---- 5. Titre --------------------------------------------------------- */
  const rank = ranking(scores, now, Object.keys(scores));
  const top = rank.find((r) => !r.blocked);
  const first = plan[0];

  let headline;
  let subline;
  if (!top) {
    headline = 'Rien de calé pour l’instant';
    subline = 'Toutes les espèces suivies sont fermées ou hors saison.';
  } else if (first && first.t > now + 30 * 60000) {
    headline = `${SPECIES_RULES[first.speciesId].name} à ${hhmm(first.t)}`;
    subline = `${first.score}/100 au pic. ${untilText(first.t - now)} pour se placer.`;
  } else if (top.score >= 60) {
    headline = `C’est le moment — ${top.rule.name}`;
    subline = `${top.score}/100 maintenant. ${top.drivingFactor ? `Ce qui porte : ${top.drivingFactor.label.toLowerCase()}.` : ''}`;
  } else if (top.score >= 40) {
    headline = `Fenêtre moyenne — ${top.rule.name}`;
    subline = top.limitingFactor
      ? `${top.score}/100. Ce qui freine : ${top.limitingFactor.label.toLowerCase()}.`
      : `${top.score}/100.`;
  } else {
    headline = 'Conditions creuses';
    subline = first
      ? `Ça remonte vers ${hhmm(first.t)} sur ${SPECIES_RULES[first.speciesId].name.toLowerCase()}.`
      : top.limitingFactor ? `Frein principal : ${top.limitingFactor.label.toLowerCase()}.` : '';
  }

  const closed = Object.keys(scores).filter((id) => getRegulationStatus(id, now).mode !== 'open');

  return { headline, subline, plan, warnings, conditions, closed, moon };
}

const overlaps = (a, b) => b.startT < a.until && b.endT > a.t;

function buildPlanEntry(w, { hourly, pos, now }) {
  const rule = SPECIES_RULES[w.speciesId];
  const wx = weather.interp(hourly, w.peakT);
  const best = spots.bestSpots(w.speciesId, w.peakT, wx, pos, 1)[0] || null;
  const turb = hourly.length ? weather.turbidity(hourly, w.peakT, 70) : null;
  const murky = turb != null && turb > 0.45;

  const lines = [];

  // Où
  if (best) {
    const where = best.distanceM != null
      ? `${best.spot.name} — ${dist(best.distanceM)} au ${Math.round(best.bearingDeg)}°`
      : best.spot.name;
    lines.push(`📍 ${where}${best.spot.seed ? ' (secteur type, à recaler)' : ''}`);
    if (best.reasons.length) lines.push(`   ${best.reasons.slice(0, 2).join(' · ')}`);
  }

  // Comment
  lines.push(`🎣 ${murky ? rule.technique.murky : rule.technique.clear}`);

  // Pourquoi ça marche / ce qui freine
  if (w.drivingFactor) lines.push(`✅ ${w.drivingFactor.label} : ${pct(w.drivingFactor.value)}`);
  if (w.limitingFactor && w.limitingFactor.value < 0.6) {
    lines.push(`⚠️ ${w.limitingFactor.label} : ${pct(w.limitingFactor.value)} — ${limitAdvice(w.limitingFactor.key, rule)}`);
  }

  // Réglementation quand elle contraint
  const reg = getRegulationStatus(w.speciesId, w.peakT);
  if (reg.mode === 'no-kill') lines.push('🚫 Période no-kill : remise à l’eau obligatoire.');
  else if (rule.regulation.minSizeCm) {
    lines.push(
      `📏 Maille ${rule.regulation.minSizeCm} cm${rule.regulation.dailyBag ? ` · ${rule.regulation.dailyBag}/jour` : ''}${
        rule.regulation.markingRequired ? ' · marquage' : ''
      }`,
    );
  }

  return {
    t: w.startT,
    until: w.endT,
    peakT: w.peakT,
    speciesId: w.speciesId,
    score: w.peakScore,
    title: `${rule.name} — ${hhmmDay(w.startT, now)} à ${hhmm(w.endT)}`,
    lines,
    spot: best,
  };
}

const pct = (v) => `${Math.round(v * 100)} %`;

function limitAdvice(key, rule) {
  switch (key) {
    case 'drift':
      return `vise ${rule.comfortableDriftKn[0]}–${rule.comfortableDriftKn[1]} nd : décale vers l’étale ou cherche un abri de courant`;
    case 'current': return 'attends que le courant s’établisse, ou déplace-toi sur une accélération';
    case 'slack': return 'l’étale est la fenêtre, cale-toi dessus à 20 min près';
    case 'wind': return 'change de bord de côte ou attends la bascule';
    case 'sea': return 'poste plus abrité, ou reporte : tu ne tiendras pas le fond';
    case 'light': return 'décale vers l’aube ou le crépuscule';
    case 'seaTemp': return 'hors de la plage thermique, cherche plus creux ou plus abrité';
    case 'coefficient': return 'ce coefficient ne joue pas pour cette espèce, mieux vaut un autre jour';
    case 'clarity': return 'eau trop brassée : volume, vibration et couleurs voyantes';
    case 'tideWindow': return 'la phase de marée n’y est pas, décale de deux heures';
    case 'pressure': return 'régime barométrique instable, facteur faible de toute façon';
    default: return 'facteur défavorable';
  }
}

const senseLabel = (s) => (s === 'flood' ? 'montant' : s === 'ebb' ? 'descendant' : 'étale');

function untilText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function nearestSample(samples, t) {
  if (!samples.length) return null;
  return samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best));
}

/**
 * Conseil court, une phrase, pour le bandeau du mode NAV.
 * C'est celui qu'on lit en tenant la barre.
 */
export function oneLiner({ now = Date.now(), samples, scores, hourly, pos }) {
  const b = brief({ now, samples, scores, hourly, pos });
  const danger = b.warnings.find((w) => w.level === 'danger');
  if (danger) return { text: danger.text, level: 'danger' };
  return { text: `${b.headline} · ${b.subline}`, level: 'info' };
}

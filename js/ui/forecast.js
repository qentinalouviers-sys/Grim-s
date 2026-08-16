/* ==========================================================================
 * ui/forecast.js — la semaine, heure par heure
 * --------------------------------------------------------------------------
 * La carte MÉTÉO de la cabine dit le temps qu'il fait MAINTENANT. Cet écran-ci
 * répond à l'autre question, celle qu'on se pose le lundi soir : quel jour
 * sortir, et à quelle heure.
 *
 * ── POURQUOI DEUX NIVEAUX, ET PAS UN SEUL ─────────────────────────────────
 * Sept jours de vent, ça fait cent soixante-huit lignes. Personne ne lit cent
 * soixante-huit lignes sur un téléphone. On choisit donc son JOUR dans une
 * bande de sept cartes — chacune donne en un coup d'œil le vent maximum, la
 * mer maximum et la direction dominante — puis on lit les VINGT-QUATRE HEURES
 * de ce jour-là, en courbe d'abord, en tableau ensuite.
 *
 * ── CE QUE L'ÉCRAN DIT DE LUI-MÊME ────────────────────────────────────────
 * La confiance d'une prévision de vent tombe avec l'échéance. Après quatre
 * jours, ce n'est plus une prévision, c'est une tendance — et faire croire
 * l'inverse, c'est envoyer quelqu'un en mer sur un chiffre qui n'existe pas.
 * Chaque jour porte donc sa mention, et les jours lointains sont grisés.
 *
 * ── LE VENT PORTE DEUX INFORMATIONS, JAMAIS UNE ───────────────────────────
 * La moyenne et la RAFALE. Vingt nœuds établis, ça se navigue ; quinze avec
 * des rafales à trente, ça se subit. L'écart entre les deux est ce qui rend
 * une journée pénible, et il est écrit partout où le vent l'est.
 * ========================================================================== */

import { el, clear, openSheet } from './dom.js';
import { Meteogram } from './widgets.js';
import * as fmt from '../core/fmt.js';
import * as weather from '../data/weather.js';
import { sunTimesOfDay } from '../data/astro.js';

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOURS_COURT = ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM'];

/** Aujourd'hui / demain nommés, le reste daté : c'est ainsi qu'on en parle. */
function dayLabel(t, now = Date.now()) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(t).setHours(0, 0, 0, 0) - d0.getTime()) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Demain';
  const d = new Date(t);
  return `${JOURS[d.getDay()]} ${d.getDate()}`;
}

const dayShort = (t) => JOURS_COURT[new Date(t).getDay()];

/**
 * @param {object} opts
 * @param {Array} opts.hourly  Série horaire de data/weather.js.
 * @param {object} opts.place  Le port choisi — pour le titre et le soleil.
 * @param {number} [opts.dayIndex] Jour à ouvrir. 0 = aujourd'hui.
 */
export function openForecast({ hourly, place, dayIndex = 0 } = {}) {
  const body = el('div');

  if (!hourly?.length) {
    body.append(el('p', 'muted',
      'Aucune prévision en mémoire. Il faut une connexion, une seule fois : '
      + 'les sept jours sont ensuite lisibles hors réseau, en mer comme au mouillage.'));
    return openSheet('Prévision', body);
  }

  const days = weather.byDay(hourly);
  let sel = Math.max(0, Math.min(days.length - 1, dayIndex));

  /* ---- La bande des jours ------------------------------------------------
   * Horizontale et défilante : sept cartes ne tiennent pas de front sur un
   * écran de 320 px, et les empiler verticalement repousserait le contenu du
   * jour choisi hors de l'écran — or c'est lui qu'on vient lire. */
  const rail = el('div', 'fc-rail');
  const railWrap = el('div', 'fc-rail-wrap');
  railWrap.append(rail);
  body.append(railWrap);

  const panel = el('div');
  body.append(panel);

  const paintRail = () => {
    clear(rail);
    days.forEach((d, i) => {
      const conf = weather.confidence(d.start);
      const card = el('button', `fc-day${i === sel ? ' on' : ''}${conf.level === 'low' ? ' far' : ''}`);
      card.type = 'button';
      card.append(el('div', 'fc-day-n', dayShort(d.start)));
      card.append(el('div', 'fc-day-d', String(new Date(d.start).getDate())));

      const s = d.summary;
      card.append(el('div', 'fc-day-w tnum',
        s.windMaxKn == null ? '—' : `${Math.round(s.windMaxKn)}`));
      card.append(el('div', 'fc-day-u', s.windDirDeg == null ? 'nd' : `nd ${fmt.cardinal(s.windDirDeg)}`));
      card.append(el('div', 'fc-day-s tnum',
        s.waveMaxM == null ? '' : `🌊 ${fmt.num(s.waveMaxM, 1)} m`));
      card.title = `${dayLabel(d.start)} — prévision ${conf.label}`;
      card.addEventListener('click', () => {
        if (sel === i) return;
        sel = i;
        paintRail();
        paintDay();
        /* Ramener la carte choisie dans le champ : on peut avoir fait défiler
         * la bande pour l'atteindre, et la voir sortir de l'écran juste après
         * l'avoir touchée donne l'impression que le choix n'a pas pris.
         * On vise `rail.children[i]` et NON `card` : paintRail() vient de
         * reconstruire la bande, et `card` est désormais un nœud détaché du
         * document — scrollIntoView() sur un nœud détaché ne fait rien, en
         * silence. C'est exactement le bug qu'on voyait sur les jours du bout. */
        rail.children[i]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      });
      rail.append(card);
    });
  };

  /* ---- Le jour choisi ---------------------------------------------------- */
  let gram = null;
  const paintDay = () => {
    gram?.destroy();
    gram = null;
    const box = clear(panel);
    const d = days[sel];
    const now = Date.now();
    const conf = weather.confidence(d.start, now);
    // Le décalage de midi qui traînait ici est maintenant dans la fonction :
    // c'est le genre de correction qu'on oublie de recopier au site suivant.
    const sun = place ? sunTimesOfDay(d.start, place.lat, place.lon) : null;

    /* En-tête du jour */
    const head = el('div', 'fc-head');
    head.append(el('div', 'fc-head-t', dayLabel(d.start, now)));
    const confChip = el('span', `chip ${conf.level === 'high' ? 'good' : conf.level === 'fair' ? '' : 'warn'}`, conf.label);
    head.append(el('div', 'spacer'), confChip);
    box.append(head);

    /* Le résumé du jour, en une phrase qu'on peut lire à voix haute */
    box.append(el('div', 'fc-sum', summarySentence(d.summary)));

    /* La courbe */
    const card = el('div', 'card tight');
    const gWrap = el('div');
    card.append(gWrap);
    box.append(card);
    gram = new Meteogram(gWrap, { height: 138 });
    gram.set(d.hours, sun, now);

    const legend = el('div', 'fc-legend');
    legend.append(
      el('span', 'fc-lg fc-lg-wind', 'vent moyen'),
      el('span', 'fc-lg fc-lg-gust', 'rafales'),
      el('span', 'fc-lg fc-lg-wave', 'mer'),
      el('span', 'fc-lg fc-lg-night', 'nuit'),
    );
    card.append(legend);

    if (sun?.sunriseT) {
      card.append(el('div', 'tiny', `Lever ${fmt.hhmm(sun.sunriseT)} · coucher ${fmt.hhmm(sun.sunsetT)}`));
    }

    /* Les vingt-quatre heures */
    const list = el('div', 'card flush');
    const hh = el('div', 'fc-row fc-row-head');
    hh.append(
      el('span', 'fc-h', 'H'),
      el('span', 'fc-wind', 'VENT / RAFALE'),
      el('span', 'fc-sea', 'MER'),
      el('span', 'fc-air', 'AIR'),
    );
    list.append(hh);

    for (const x of d.hours) {
      const past = x.t < now - 3600000;
      const cur = x.t <= now && x.t + 3600000 > now;
      const row = el('div', `fc-row${past ? ' past' : ''}${cur ? ' now' : ''}`);

      row.append(el('span', 'fc-h tnum', fmt.hhmm(x.t)));

      const wind = el('span', 'fc-wind');
      /* La flèche pointe LÀ OÙ LE VENT VA, comme sur toutes les cartes marines :
       * un vent DE nord-ouest pousse vers le sud-est, et la flèche descend vers
       * la droite. Le texte, lui, dit d'où il vient — les deux ensemble lèvent
       * l'ambiguïté qui fait confondre un vent portant et un vent debout. */
      wind.append(arrow(x.windDirDeg, beaufortColor(x.windSpeedKn)));
      const wv = el('span', 'fc-wind-v tnum',
        `${Math.round(x.windSpeedKn ?? 0)}`);
      wv.style.color = beaufortColor(x.windSpeedKn);
      wind.append(wv);
      const gust = x.windGustKn ?? 0;
      wind.append(el('span', 'fc-wind-g tnum',
        gust > (x.windSpeedKn ?? 0) + 2 ? `/${Math.round(gust)}` : ''));
      wind.append(el('span', 'fc-wind-c', fmt.cardinal(x.windDirDeg)));
      row.append(wind);

      row.append(el('span', 'fc-sea tnum',
        x.waveHeightM == null ? '—' : `${fmt.num(x.waveHeightM, 1)}${
          x.wavePeriodS ? ` · ${Math.round(x.wavePeriodS)}s` : ''}`));

      const air = el('span', 'fc-air tnum',
        `${x.airTempC == null ? '—' : Math.round(x.airTempC)}°${
          x.precipMm > 0.1 ? ` ☂${fmt.num(x.precipMm, 1)}` : ''}`);
      row.append(air);
      list.append(row);
    }
    box.append(list);

    box.append(el('div', 'tiny',
      `Vent, rafales, air et pluie : Open-Meteo. Mer et houle : Open-Meteo Marine. `
      + `Heures locales${place ? ` de ${place.name}` : ''}. La rafale est la pointe de l’heure, pas sa moyenne.`));
  };

  paintRail();
  paintDay();

  // Titre court : « Prévision 7 jours — Saint-Vaast-la-Hougue » passait sur
  // deux lignes et poussait la bande des jours vers le bas. Le nombre de jours
  // se compte dans la bande, il n'a pas à être écrit deux fois.
  const sheet = openSheet(`Prévision${place ? ` — ${place.name}` : ''}`, body, () => {
    gram?.destroy();
    gram = null;
  });

  // Ouvrir sur aujourd'hui en ayant la carte du jour visible dans la bande.
  setTimeout(() => rail.children[sel]?.scrollIntoView({ block: 'nearest', inline: 'center' }), 60);
  return sheet;
}

/* ==========================================================================
 * Petites fabrications
 * ========================================================================== */

/**
 * Une phrase, pas une liste de champs. « Vent de nord-ouest, 12 à 22 nœuds,
 * rafales 31. Mer jusqu'à 1,4 m. » se retient ; quatre pastilles séparées, non.
 */
function summarySentence(s) {
  const parts = [];
  if (s.windDirDeg != null) parts.push(fmt.windFrom(s.windDirDeg));
  if (s.windMaxKn != null) {
    const lo = Math.round(s.windMinKn ?? s.windMaxKn);
    const hi = Math.round(s.windMaxKn);
    parts.push(lo === hi ? `${hi} nd` : `${lo} à ${hi} nd`);
  }
  if (s.gustMaxKn != null && s.gustMaxKn > (s.windMaxKn ?? 0) + 3) {
    parts.push(`rafales ${Math.round(s.gustMaxKn)} nd`);
  }
  const second = [];
  if (s.waveMaxM != null) second.push(`Mer jusqu’à ${fmt.num(s.waveMaxM, 1)} m`);
  // « air » écrit en toutes lettres : à côté d'une température d'eau et d'une
  // hauteur de mer, deux nombres suivis d'un degré ne disent pas d'eux-mêmes
  // de quoi ils parlent.
  if (s.airMaxC != null) second.push(`air ${Math.round(s.airMinC)} à ${Math.round(s.airMaxC)}°`);
  if (s.precipMm > 0.5) second.push(`${fmt.num(s.precipMm, 1)} mm de pluie`);

  const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : '');
  return [cap(parts.join(', ')), second.join(', ')].filter(Boolean).join('. ') + '.';
}

/**
 * La couleur suit Beaufort, et les seuils sont ceux d'un petit bateau de pêche
 * — pas ceux d'un voilier de course. Vert jusqu'à force 3, ambre à force 4-5
 * (ça se fait, mais ça secoue), rouge à partir de force 6 : au-delà de 22
 * nœuds, une embarcation de six mètres ne travaille plus, elle encaisse.
 */
function beaufortColor(kn) {
  if (kn == null) return '#9fb4cc';
  if (kn < 11) return '#a3e635';
  if (kn < 17) return '#fbbf24';
  if (kn < 22) return '#fb923c';
  return '#fb5a72';
}

/**
 * Flèche dessinée, orientée vers où le vent POUSSE — la convention de toutes
 * les cartes marines.
 *
 * ── LE CALCUL, PARCE QU'IL EST FACILE DE LE RATER ─────────────────────────
 * `dirDeg` est la direction D'OÙ vient le vent. La flèche doit pointer vers
 * `dirDeg + 180` en degrés compas (0 = nord = haut de l'écran).
 * Le dessin de base pointe vers le BAS, c'est-à-dire vers le sud, soit 180°.
 * Une rotation CSS ajoute donc son angle à ces 180° : pour atteindre
 * `dirDeg + 180`, il faut tourner de `dirDeg`, et non de `dirDeg + 180`.
 * Avec +180 la flèche pointait exactement à l'envers — vers l'origine du vent
 * au lieu de sa destination, ce qui fait confondre vent portant et vent debout.
 */
function arrow(dirDeg, color) {
  const s = el('span', 'fc-arrow');
  s.setAttribute('aria-hidden', 'true');
  const rot = Number.isFinite(dirDeg) ? dirDeg % 360 : 0;
  s.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" style="transform:rotate(${rot}deg)">
      <path d="M8 1.6 L8 14.4 M8 14.4 L4.6 10.6 M8 14.4 L11.4 10.6"
            fill="none" stroke="${color}" stroke-width="1.9"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  return s;
}

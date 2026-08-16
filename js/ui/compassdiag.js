/* ==========================================================================
 * ui/compassdiag.js — pourquoi le cap va mal
 * --------------------------------------------------------------------------
 * Une page de nombres bruts, et c'est délibéré : quand le cap déraille en mer,
 * la question n'est pas « que faire » mais « qui ment » — le magnétomètre,
 * l'autorisation iOS, le filtre, ou l'affichage. Chacun a sa ligne ici, et la
 * page se rafraîchit quatre fois par seconde pour qu'on puisse tourner le
 * téléphone à la main et voir laquelle suit le geste.
 *
 * Elle vivait dans la vue NAV, avec le compas. Le compas est parti dans le
 * MODE NAVIGATION quand NAV est devenue la CABINE ; le diagnostic l'a suivi.
 * Il est ici plutôt que dans drive.js pour qu'un futur écran de cap puisse
 * l'ouvrir sans importer tout un cockpit — et sans créer un cycle d'imports
 * entre deux vues.
 * ========================================================================== */

import { state } from '../core/store.js';
import { APP_VERSION } from '../core/build.js';
import { el, button, toast, openSheet, clear } from './dom.js';
import { angleDiff } from '../core/geo.js';
import * as fmt from '../core/fmt.js';
import * as compass from '../sensors/heading.js';

/**
 * Tout ce qui permet de dire POURQUOI le cap va mal, sans rien inventer.
 * Rafraîchi en direct : c'est en tournant le téléphone pendant que l'écran est
 * ouvert qu'on voit si le retard vient du capteur ou de l'affichage.
 */
export function openCompassDiag() {
  const body = el('div');
  const grid = el('div');
  body.append(grid);

  const note = el('p', 'tiny',
    'Tourne le téléphone lentement pendant que cet écran est ouvert. Si « brut » ' +
    'suit ton geste et que « cadence » reste au-dessus de 20 Hz, le capteur va ' +
    'bien. Si la cadence est basse ou nulle, c’est l’autorisation ou l’appareil.');
  body.append(note);

  const help = el('div', 'tiny');
  help.style.marginTop = '8px';
  body.append(help);

  const btn = button('Redemander l’autorisation', 'btn-lg', async () => {
    const res = await compass.requestPermission();
    toast(`Autorisation : ${res}`, res === 'granted' ? 'good' : 'warn');
  });
  body.append(btn);

  // Rapporter un compas qui déraille ne doit pas obliger à recopier vingt
  // lignes à la main ni à cadrer une capture d'écran d'une main sur un pont
  // qui bouge.
  body.append(button('📋 Copier le diagnostic', 'btn-sm', async () => {
    const d = compass.diagnostics();
    const txt = [
      `Grim's Compagnon ${APP_VERSION} — diagnostic compas`,
      new Date().toISOString(),
      navigator.userAgent,
      '',
      ...Object.entries({
        supporté: d.supported, autorisation: d.permission, écoute: d.listening,
        mesures: d.events, ignorés: d.ignored, cadence_Hz: d.rateHz.toFixed(1),
        âge_ms: d.ageMs, source: d.lockedType, champ: d.field, absolu: d.absolute,
        alpha: d.alpha, beta: d.beta, gamma: d.gamma,
        correction_assiette: d.tiltFix, accord_axes: d.axisQuality,
        brut: d.raw, filtré: d.filtered,
        cap_affiché: state.heading?.deg, origine: state.heading?.source,
        bruit: state.heading?.spread,
      }).map(([k, v]) => `${k}: ${v}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      toast('Diagnostic copié — colle-le dans un message', 'good');
    } catch {
      toast('Copie refusée par le navigateur');
    }
  }));

  const line = (k, v) => {
    const r = el('div', 'row');
    r.style.justifyContent = 'space-between';
    r.style.padding = '3px 0';
    r.append(el('span', 'tiny', k), el('span', 'tnum', v));
    r.lastChild.style.fontSize = '13px';
    r.lastChild.style.fontWeight = '650';
    return r;
  };

  const paint = () => {
    const d = compass.diagnostics();
    const hd = state.heading;
    clear(grid);
    grid.append(line('Version', APP_VERSION));
    grid.append(line('Compas disponible', d.supported ? 'oui' : 'NON'));
    grid.append(line('Autorisation', d.permission));
    grid.append(line('Écoute active', d.listening ? 'oui' : 'NON'));
    grid.append(line('Mesures reçues', String(d.events)));
    grid.append(line('Cadence', d.events ? `${d.rateHz.toFixed(1)} Hz` : '—'));
    grid.append(line('Âge dernière mesure', d.ageMs == null ? '—' : `${d.ageMs} ms`));
    grid.append(line('Source retenue', d.lockedType));
    grid.append(line('Champ utilisé', d.field || '—'));
    grid.append(line('Référence absolue', d.absolute === null ? 'non annoncée' : String(d.absolute)));
    grid.append(line('Flux ignorés', String(d.ignored)));
    grid.append(line('Cap brut (mag)', d.raw == null ? '—' : `${d.raw.toFixed(1)}°`));
    grid.append(line('Cap filtré (mag)', d.filtered == null ? '—' : `${d.filtered.toFixed(1)}°`));
    grid.append(line('Retard du filtre', d.raw == null || d.filtered == null
      ? '—' : `${Math.abs(angleDiff(d.raw, d.filtered)).toFixed(1)}°`));
    grid.append(line('Cap affiché (vrai)', hd ? fmt.heading(hd.deg) : '—'));
    grid.append(line('Origine du cap', hd?.source || '—'));
    grid.append(line('Bruit du capteur', hd?.spread == null ? '—' : `${hd.spread.toFixed(1)}°`));
    grid.append(line('Précision annoncée', d.accuracy == null ? 'non fournie' : `${d.accuracy}°`));
    grid.append(line('Assiette (β / γ)', d.beta == null ? '—'
      : `${Math.round(d.beta)}° / ${Math.round(d.gamma ?? 0)}°`));
    grid.append(line('Correction d’assiette', `${d.tiltFix > 0 ? '+' : ''}${(d.tiltFix ?? 0).toFixed(1)}°`));
    grid.append(line('Accord des axes', `${Math.round((d.axisQuality ?? 1) * 100)} %`));

    help.textContent =
      !d.supported ? 'Cet appareil n’expose pas d’orientation : le cap restera la route fond GPS.'
      : d.events === 0 && d.needsPermission ? 'Aucune mesure et une autorisation à donner : appuie sur le bouton ci-dessous, c’est le cas le plus fréquent sur iPhone.'
      : d.events === 0 ? 'Aucune mesure reçue alors que l’autorisation ne semble pas en cause. Le magnétomètre est peut-être désactivé dans les réglages du téléphone.'
      : d.rateHz > 0 && d.rateHz < 8 ? 'Le capteur émet très peu souvent : le retard vient de lui, pas de l’affichage.'
      : d.ignored > d.events ? 'Beaucoup de flux écartés : deux sources d’orientation se contredisent, seule la plus fiable est gardée.'
      : 'Le capteur alimente correctement l’affichage.';
    btn.hidden = !d.needsPermission;
  };

  paint();
  const iv = setInterval(paint, 250);
  openSheet('Diagnostic compas', body, () => clearInterval(iv));
}

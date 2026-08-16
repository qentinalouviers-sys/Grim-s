/* ==========================================================================
 * core/kdf.js — l'étirement du mot de passe, dans le navigateur
 * --------------------------------------------------------------------------
 * POURQUOI CE FICHIER EXISTE
 *
 * Un hachage de mot de passe est coûteux par construction : c'est toute sa
 * fonction. Un attaquant qui vole la base doit refaire ce calcul pour CHAQUE
 * mot de passe qu'il essaie, et c'est ce coût-là qui rend l'essai systématique
 * inintéressant.
 *
 * Or le serveur ne peut pas le payer. Sur Cloudflare Workers, l'offre gratuite
 * accorde dix millisecondes de temps processeur par requête. Mesuré :
 *
 *      10 000 tours →  6,5 ms   (déjà au bord)
 *     210 000      →   95 ms
 *     600 000      →  273 ms    (la recommandation courante)
 *
 * Baisser le nombre de tours pour tenir dans le budget reviendrait à publier
 * des mots de passe à peine protégés. Ce sont des mots de passe que leurs
 * propriétaires réutilisent à la banque et sur leur messagerie : ce n'est pas
 * un compromis qu'on a le droit de faire à leur place.
 *
 * Alors le calcul change de machine. Le téléphone étire, et n'envoie que le
 * résultat. Le serveur ne voit JAMAIS le mot de passe — il ne peut donc pas le
 * perdre, ni le journaliser par accident, ni se le faire voler.
 *
 * CE QUE ÇA PROTÈGE, ET CE QUE ÇA NE PROTÈGE PAS
 *
 * Face à une copie volée de la base : pour tester un mot de passe, l'attaquant
 * doit refaire les 600 000 tours. Le facteur de travail recommandé est donc
 * bien là ; il a seulement déménagé. Et l'empreinte volée ne permet pas de se
 * connecter : le serveur exige la clé, pas son empreinte.
 *
 * Ce que ça ne remplace pas : TLS. La clé dérivée voyage en clair dans le
 * corps de la requête et vaut mot de passe pour qui l'intercepte — comme un
 * mot de passe. HTTPS reste obligatoire, ni plus ni moins qu'avant.
 *
 * Et une conséquence qu'il faut connaître : le serveur ne pouvant plus lire le
 * mot de passe, il ne peut plus en vérifier la longueur. C'est l'écran de
 * compte qui la tient. Quelqu'un qui contournerait l'app pour se donner un mot
 * de passe d'un caractère n'exposerait que son propre compte.
 * ========================================================================== */

/** Tours de PBKDF2-HMAC-SHA256. Aligné sur la recommandation OWASP. */
export const ITERATIONS = 600_000;

/**
 * Étiquette de version du schéma.
 *
 * Elle entre dans le sel. Le jour où il faudra changer d'algorithme ou de
 * nombre de tours, les anciennes clés resteront calculables telles quelles :
 * on saura les distinguer au lieu de fermer les comptes existants.
 */
const VERSION = 'grims-kdf-v1';

/**
 * Le sel se dérive de l'adresse, et non d'un aléa fourni par le serveur.
 *
 * C'est imposé par l'ordre des opérations : le client doit calculer sa clé
 * AVANT d'être authentifié, donc avant que le serveur ait quoi que ce soit à
 * lui dire. Un sel n'a pas besoin d'être secret — seulement d'être distinct
 * d'un compte à l'autre, pour qu'une table précalculée ne serve qu'une fois.
 * Le sel aléatoire, lui, existe bien : le serveur en ajoute un par-dessus.
 */
async function saltFor(email) {
  const bytes = new TextEncoder().encode(`${VERSION}:${String(email).trim().toLowerCase()}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Dérive la clé envoyée au serveur à la place du mot de passe.
 *
 * @param {string} email    l'adresse du compte — elle sert de sel
 * @param {string} password le mot de passe tapé, qui ne sort jamais d'ici
 * @returns {Promise<string>} 256 bits en hexadécimal minuscule
 */
export async function deriveKey(email, password) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: await saltFor(email), iterations: ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Disponibilité de WebCrypto — absent hors contexte sécurisé (HTTP simple). */
export const available = () =>
  typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.deriveBits === 'function';

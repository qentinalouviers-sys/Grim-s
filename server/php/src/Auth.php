<?php
/* ==========================================================================
 * Auth.php — comptes, jetons, limitation de débit
 * --------------------------------------------------------------------------
 * Ce fichier garde des mots de passe. Pas « les mots de passe de l'app » :
 * les mots de passe que ses utilisateurs réutilisent ailleurs, à la banque et
 * sur leur messagerie. C'est ce qui justifie chaque précaution ci-dessous,
 * même celles qui paraissent excessives pour une application de pêche.
 * ========================================================================== */

declare(strict_types=1);

final class Auth
{
    /** Durée de vie d'un jeton. Long, et c'est délibéré — voir plus bas. */
    private const TOKEN_TTL = 90 * 86400;

    private const RESET_TTL = 3600;

    /** Fenêtre et plafond de la limitation par adresse IP. */
    private const RL_WINDOW = 60;
    private const RL_MAX = 5;

    private static array $cfg = [];

    public static function configure(array $cfg): void
    {
        self::$cfg = $cfg;
    }

    /* ======================================================================
     * Hachage
     * ==================================================================== */

    /**
     * argon2id quand l'hébergeur le fournit, bcrypt coût 12 sinon.
     *
     * `password_verify` reconnaît le format à la lecture : un serveur qui
     * gagne argon2id après coup continue de vérifier les anciens hachages
     * bcrypt sans rien migrer. C'est pour ça qu'on ne fige pas l'algorithme
     * dans la base.
     */
    /** Forme d'une clé dérivée par le client : 256 bits en hexadécimal. */
    private const KEY_RE = '/^[0-9a-f]{64}$/';

    /**
     * L'étirement, embarqué dans la page de réinitialisation.
     *
     * Il fait exactement ce que fait `js/core/kdf.js` : même sel, même nombre
     * de tours, même encodage. Toute divergence entre les deux se paierait par
     * un compte devenu inaccessible après une réinitialisation réussie — la
     * pire des pannes, puisqu'elle se déclare longtemps après la manœuvre.
     */
    private const KDF_SCRIPT = <<<'JS'
const f = document.getElementById('f');
if (f) f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
  if (p1.length < 8) return alert('Le mot de passe doit faire au moins huit caractères.');
  if (p1 !== p2) return alert('Les deux mots de passe ne sont pas identiques.');
  const b = document.getElementById('b');
  b.disabled = true; b.textContent = 'Chiffrement…';
  const enc = new TextEncoder();
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('grims-kdf-v1:' + EMAIL.trim().toLowerCase())));
  const k = await crypto.subtle.importKey('raw', enc.encode(p1), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000}, k, 256);
  document.getElementById('key').value = [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('');
  f.submit();
});
JS;

    /**
     * Impose que ce qui arrive soit une clé dérivée, et non un mot de passe.
     *
     * Le client étire le mot de passe dans le navigateur (`js/core/kdf.js`,
     * 600 000 tours de PBKDF2) et n'envoie que le résultat. Ce serveur-ci
     * pourrait très bien hacher un mot de passe brut — mais son jumeau sur
     * Cloudflare Workers ne le peut pas, faute de temps processeur. Les deux
     * doivent parler le même protocole, sinon un compte créé sur l'un ne
     * s'ouvre pas sur l'autre.
     *
     * Conséquence assumée : la longueur minimale du mot de passe ne peut plus
     * être vérifiée ici, puisqu'il n'arrive jamais. C'est le client qui la
     * tient. Un client bricolé peut donc se donner un mot de passe d'un
     * caractère — il n'expose que son propre compte, et c'est le prix de ne
     * jamais transmettre le mot de passe lui-même.
     */
    private static function assertStretched(mixed $value): void
    {
        if (!is_string($value) || !preg_match(self::KEY_RE, $value)) {
            Http::fail('client_outdated', 400);
        }
    }

    private static function hash(string $password): string
    {
        if (defined('PASSWORD_ARGON2ID')) {
            $h = @password_hash($password, PASSWORD_ARGON2ID);
            if (is_string($h) && $h !== '') {
                return $h;
            }
        }
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
    }

    /* ======================================================================
     * Limitation de débit
     * ==================================================================== */

    private static function throttle(string $action): void
    {
        $pdo = Db::pdo();
        $now = time();

        $st = $pdo->prepare('SELECT COUNT(*) FROM attempts WHERE ip = ? AND action = ? AND at > ?');
        $st->execute([Http::ip(), $action, $now - self::RL_WINDOW]);
        if ((int) $st->fetchColumn() >= self::RL_MAX) {
            Http::fail('rate_limited', 429);
        }

        $pdo->prepare('INSERT INTO attempts (ip, action, at) VALUES (?, ?, ?)')
            ->execute([Http::ip(), $action, $now]);

        /* Purge opportuniste : sans elle la table grossit indéfiniment, et sur
         * mutualisé le quota disque finit par tomber au pire moment. Une fois
         * sur cinquante suffit — ce n'est pas une donnée qu'on regrette. */
        if (random_int(1, 50) === 1) {
            $pdo->prepare('DELETE FROM attempts WHERE at < ?')->execute([$now - 3600]);
        }
    }

    /* ======================================================================
     * Jetons
     * ==================================================================== */

    /**
     * Le jeton est rendu au client en clair ; la base n'en garde que
     * l'empreinte. Une copie de la table `tokens` ne permet donc de se
     * connecter à aucun compte — c'est la même raison qui interdit de stocker
     * un mot de passe en clair, appliquée à ce qui en tient lieu.
     */
    private static function issueToken(string $userId): string
    {
        $token = bin2hex(random_bytes(32));
        $now = time();
        Db::pdo()->prepare(
            'INSERT INTO tokens (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)'
        )->execute([hash('sha256', $token), $userId, $now, $now + self::TOKEN_TTL, $now]);

        return $token;
    }

    /**
     * Identifie l'appelant, ou répond 401 et coupe.
     *
     * Le 401 a un sens précis côté client : il efface la session locale et
     * affiche « session expirée ». Il ne doit donc sortir QUE d'ici, pour un
     * jeton invalide, expiré ou révoqué. Un 401 rendu par erreur sur un corps
     * mal formé déconnecterait l'utilisateur sans raison.
     */
    public static function user(): array
    {
        $token = Http::bearer();
        if ($token === null || $token === '') {
            Http::fail('unauthorized', 401);
        }

        $st = Db::pdo()->prepare(
            'SELECT t.token_hash, t.expires_at, t.last_used_at, u.id, u.email, u.name
               FROM tokens t JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = ?'
        );
        $st->execute([hash('sha256', $token)]);
        $row = $st->fetch();

        if (!$row) {
            Http::fail('unauthorized', 401);
        }

        $now = time();
        if ((int) $row['expires_at'] < $now) {
            Db::pdo()->prepare('DELETE FROM tokens WHERE token_hash = ?')->execute([$row['token_hash']]);
            Http::fail('unauthorized', 401);
        }

        /* Prolongation glissante. Un jeton d'une heure obligerait à se
         * reconnecter en mer, sans réseau, avec les mains mouillées — c'est
         * exactement le moment où l'app doit se contenter de fonctionner.
         * On repousse l'échéance, sans réécrire à chaque appel. */
        if ($now - (int) $row['last_used_at'] > 86400) {
            Db::pdo()->prepare('UPDATE tokens SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
                ->execute([$now, $now + self::TOKEN_TTL, $row['token_hash']]);
        }

        return ['id' => $row['id'], 'email' => $row['email'], 'name' => $row['name']];
    }

    /* ======================================================================
     * Routes
     * ==================================================================== */

    /**
     * Qui a le droit de créer un compte.
     *
     * Une API ouverte dont l'inscription est libre finit par héberger les
     * données de gens qu'on n'a pas invités — sur son quota, et bientôt sur sa
     * carte de flotte. Ils ne lisent pas les données des autres : le filtre
     * `user_id` est dans chaque requête, pas dans un réglage qu'on peut
     * oublier. Mais ils occupent la place.
     *
     * `invite_code` vide : l'inscription reste ouverte, comme avant.
     * `hash_equals` compare à temps constant — un `===` s'arrête au premier
     * caractère différent, et sur un code qu'on essaie en boucle, la durée
     * finit par dire combien de tête est juste.
     */
    private static function checkInvite(array $b): void
    {
        $expected = (string) (self::$cfg['invite_code'] ?? '');
        if ($expected === '') {
            return;
        }
        $given = trim((string) ($b['invite'] ?? ''));
        if ($given === '') {
            Http::fail('invite_required', 403);
        }
        if (!hash_equals($expected, $given)) {
            Http::fail('invite_invalid', 403);
        }
    }

    public static function register(): never
    {
        self::throttle('register');
        $b = Http::body();
        self::checkInvite($b);

        $email = trim((string) ($b['email'] ?? ''));
        $password = (string) ($b['password'] ?? '');
        $name = isset($b['name']) && $b['name'] !== null ? trim((string) $b['name']) : null;

        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) {
            Http::fail('invalid_email', 400);
        }
        self::assertStretched($password);

        $key = mb_strtolower($email);
        $pdo = Db::pdo();

        $st = $pdo->prepare('SELECT id FROM users WHERE email_key = ?');
        $st->execute([$key]);
        if ($st->fetch()) {
            Http::fail('email_taken', 409);
        }

        $id = 'u_' . bin2hex(random_bytes(8));
        try {
            $pdo->prepare(
                'INSERT INTO users (id, email, email_key, pass_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            )->execute([$id, $email, $key, self::hash($password), $name !== '' ? $name : null, time()]);
        } catch (PDOException $e) {
            /* Deux inscriptions simultanées sur la même adresse : l'index
             * unique tranche. Le SELECT ci-dessus ne suffit pas, il y a une
             * fenêtre entre les deux. */
            Http::fail('email_taken', 409);
        }

        Http::json([
            'token' => self::issueToken($id),
            'user' => ['id' => $id, 'email' => $email, 'name' => $name !== '' ? $name : null],
        ]);
    }

    public static function login(): never
    {
        self::throttle('login');
        $b = Http::body();

        $email = trim((string) ($b['email'] ?? ''));
        $password = (string) ($b['password'] ?? '');
        self::assertStretched($password);

        $st = Db::pdo()->prepare(
            'SELECT id, email, name, pass_hash, fail_count, locked_until FROM users WHERE email_key = ?'
        );
        $st->execute([mb_strtolower($email)]);
        $u = $st->fetch();

        if ($u && (int) $u['locked_until'] > time()) {
            Http::fail('account_locked', 423);
        }

        /* Compte inconnu : on vérifie quand même un haché factice. Sans ça, la
         * réponse revient en une microseconde pour une adresse inconnue et en
         * cent millisecondes pour une adresse connue — de quoi établir la
         * liste des inscrits sans jamais deviner un seul mot de passe. */
        $hash = $u ? (string) $u['pass_hash'] : '$2y$12$UQh/8VSeGqpXR/m2Fuh2UOFwSzOEHLQNnE7mlJD6HnDO3n1asS5ye';
        $ok = password_verify($password, $hash) && $u !== false;

        if (!$ok) {
            if ($u) {
                $fails = (int) $u['fail_count'] + 1;
                /* Verrou progressif au-delà de dix échecs : quelques minutes,
                 * puis davantage. Ça ne gêne pas un propriétaire qui se trompe
                 * de doigt, et ça rend l'essai systématique inexploitable. */
                $lock = $fails >= 10 ? time() + min(900, 30 * ($fails - 9)) : 0;
                Db::pdo()->prepare('UPDATE users SET fail_count = ?, locked_until = ? WHERE id = ?')
                    ->execute([$fails, $lock, $u['id']]);
            }
            /* UN SEUL code pour « adresse inconnue » et « mot de passe faux ».
             * Distinguer les deux, c'est publier qui a un compte. */
            Http::fail('bad_credentials', 401);
        }

        if ((int) $u['fail_count'] !== 0) {
            Db::pdo()->prepare('UPDATE users SET fail_count = 0, locked_until = 0 WHERE id = ?')->execute([$u['id']]);
        }

        Http::json([
            'token' => self::issueToken($u['id']),
            'user' => ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name']],
        ]);
    }

    public static function logout(): never
    {
        $token = Http::bearer();
        if ($token !== null && $token !== '') {
            Db::pdo()->prepare('DELETE FROM tokens WHERE token_hash = ?')->execute([hash('sha256', $token)]);
        }
        /* Pas de 401 si le jeton est déjà mort : se déconnecter deux fois doit
         * réussir deux fois. Le client n'attend pas cette réponse de toute
         * façon — il efface sa session localement quoi qu'il arrive. */
        Http::json(['ok' => true]);
    }

    public static function forgot(): never
    {
        self::throttle('forgot');
        $b = Http::body();
        $email = trim((string) ($b['email'] ?? ''));

        /* Sans expéditeur configuré, la route existe mais ne peut rien faire.
         * On répond 501, que le client reconnaît et traduit par « pas encore
         * en service » — plutôt qu'un « erreur » qui ferait chercher une faute
         * de frappe dans l'adresse pendant un quart d'heure. */
        $from = self::$cfg['mail_from'] ?? '';
        $base = self::$cfg['public_url'] ?? '';
        if ($from === '' || $base === '') {
            Http::fail('not_implemented', 501);
        }

        $st = Db::pdo()->prepare('SELECT id, email FROM users WHERE email_key = ?');
        $st->execute([mb_strtolower($email)]);
        $u = $st->fetch();

        if ($u) {
            $token = bin2hex(random_bytes(32));
            $now = time();
            Db::pdo()->prepare(
                'INSERT INTO resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
            )->execute([hash('sha256', $token), $u['id'], $now, $now + self::RESET_TTL]);

            $link = rtrim($base, '/') . '/reset?t=' . $token;
            $body = "Bonjour,\n\n"
                . "Une réinitialisation du mot de passe a été demandée pour ce compte.\n"
                . "Ce lien est valable une heure et ne fonctionne qu'une fois :\n\n"
                . $link . "\n\n"
                . "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message :\n"
                . "votre mot de passe reste inchangé.\n";

            @mail($u['email'], 'Grim\'s Compagnon — mot de passe', $body, [
                'From' => $from,
                'Content-Type' => 'text/plain; charset=utf-8',
            ]);
        }

        /* 200 dans TOUS les cas, compte existant ou non. Répondre 404 sur une
         * adresse inconnue transformerait ce formulaire en annuaire. */
        Http::json(['ok' => true]);
    }

    /**
     * Page de réinitialisation, servie par le serveur lui-même.
     *
     * Ce n'est pas l'app qui gère cette étape : c'est une page unique, ouverte
     * depuis un lien reçu par courriel, et la PWA n'a pas de routage d'URL
     * profondes pour l'accueillir.
     */
    public static function resetPage(): never
    {
        $token = (string) ($_GET['t'] ?? '');
        $done = false;
        $error = '';
        $email = '';

        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $token = (string) ($_POST['t'] ?? '');
            /* La page envoie la CLÉ DÉRIVÉE, pas le mot de passe — exactement
             * comme l'application. Si les deux calculs divergeaient, le mot de
             * passe changé ici ne rouvrirait plus le compte. */
            $pw = (string) ($_POST['key'] ?? '');

            if (!preg_match(self::KEY_RE, $pw)) {
                $error = 'Le navigateur n\'a pas pu préparer le mot de passe. Réessayez.';
            } else {
                $st = Db::pdo()->prepare('SELECT token_hash, user_id, expires_at, used_at FROM resets WHERE token_hash = ?');
                $st->execute([hash('sha256', $token)]);
                $r = $st->fetch();

                if (!$r || (int) $r['used_at'] !== 0 || (int) $r['expires_at'] < time()) {
                    $error = 'Ce lien a expiré ou a déjà servi. Redemandez-en un depuis l\'application.';
                } else {
                    Db::pdo()->prepare('UPDATE users SET pass_hash = ?, fail_count = 0, locked_until = 0 WHERE id = ?')
                        ->execute([self::hash($pw), $r['user_id']]);
                    Db::pdo()->prepare('UPDATE resets SET used_at = ? WHERE token_hash = ?')
                        ->execute([time(), $r['token_hash']]);
                    /* Changer de mot de passe déconnecte partout ailleurs.
                     * Quelqu'un qui fait cette démarche soupçonne souvent un
                     * accès qui n'est pas le sien : laisser vivre les jetons
                     * existants viderait la manœuvre de tout son sens. */
                    Db::pdo()->prepare('DELETE FROM tokens WHERE user_id = ?')->execute([$r['user_id']]);
                    $done = true;
                }
            }
        }

        /* L'adresse du compte est nécessaire à la page : le sel de dérivation
         * s'en déduit. Celui qui tient le lien l'a déjà reçue par courriel. */
        if (!$done && $token !== '') {
            $st = Db::pdo()->prepare(
                'SELECT u.email FROM resets r JOIN users u ON u.id = r.user_id
                  WHERE r.token_hash = ? AND r.used_at = 0 AND r.expires_at > ?'
            );
            $st->execute([hash('sha256', $token), time()]);
            $email = (string) ($st->fetchColumn() ?: '');
            if ($email === '' && $error === '') {
                $error = 'Ce lien a expiré ou a déjà servi.';
            }
        }

        header('Content-Type: text/html; charset=utf-8');
        $t = htmlspecialchars($token, ENT_QUOTES);
        $e = htmlspecialchars($error, ENT_QUOTES);
        $inner = $done
            ? '<p class="ok">Mot de passe changé. Retournez dans l\'application et connectez-vous.</p>'
            : ($e !== '' ? "<p class=\"err\">$e</p>" : '')
                . ($email === '' ? '' :
                    '<form method="post" id="f"><input type="hidden" name="t" value="' . $t . '">'
                    . '<input type="hidden" name="key" id="key">'
                    . '<p class="who">' . htmlspecialchars($email, ENT_QUOTES) . '</p>'
                    . '<label>Nouveau mot de passe<input type="password" id="p1" autocomplete="new-password" minlength="8" required></label>'
                    . '<label>Répétez-le<input type="password" id="p2" autocomplete="new-password" minlength="8" required></label>'
                    . '<button type="submit" id="b">Enregistrer</button></form>');

        echo '<!doctype html><html lang="fr"><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width,initial-scale=1">'
            . '<title>Grim\'s Compagnon — mot de passe</title><style>'
            . 'body{font:16px/1.5 system-ui,sans-serif;background:#0b1220;color:#e8eef7;margin:0;'
            . 'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}'
            . 'main{max-width:24rem;width:100%}h1{font-size:1.25rem;margin:0 0 1rem}'
            . 'label{display:block;margin:0 0 1rem}input{width:100%;box-sizing:border-box;padding:.7rem;'
            . 'margin-top:.35rem;border-radius:.5rem;border:1px solid #2a3a52;background:#111c2e;color:inherit;font-size:1rem}'
            . 'button{width:100%;padding:.8rem;border:0;border-radius:.5rem;background:#2f81f7;color:#fff;font-size:1rem}'
            . 'button[disabled]{opacity:.6}.who{color:#8fa7c4;margin:0 0 1rem;font-size:.9rem}'
            . '.err{color:#ffb4a2}.ok{color:#9ae6b4}'
            . '</style><main><h1>Nouveau mot de passe</h1>' . $inner . '</main>'
            . '<script>const EMAIL=' . json_encode($email, JSON_UNESCAPED_UNICODE) . ';'
            . self::KDF_SCRIPT . '</script></html>';
        exit;
    }
}

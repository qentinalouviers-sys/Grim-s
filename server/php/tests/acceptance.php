<?php
/* ==========================================================================
 * tests/acceptance.php — la recette, dans l'ordre où elle doit passer
 * --------------------------------------------------------------------------
 * Chaque étape suppose la précédente. On la lance contre le serveur local
 * pendant le développement, et contre l'hébergement APRÈS le dépôt : c'est
 * la seule façon de savoir si le .htaccess, le CORS et les limites de taille
 * de l'hébergeur tiennent réellement.
 *
 *   php -S 127.0.0.1:8787 -t public public/index.php &
 *   php tests/acceptance.php http://127.0.0.1:8787
 *
 * ELLE SE LANCE AUSSI CONTRE LA PRODUCTION, et c'est même là qu'elle sert le
 * plus : le CORS et le passage de l'en-tête `Authorization` fonctionnent
 * partout en développement et cassent une fois en ligne. Un `/api/health` vert
 * ne les éprouve pas.
 *
 * Elle ne touche à aucune donnée existante : elle crée un compte à une adresse
 * tirée au hasard, s'en sert, puis le supprime. Le seul effet qui survit est
 * l'adresse IP de l'appelant en limitation de débit pendant une minute.
 * ========================================================================== */

declare(strict_types=1);

$base = rtrim($argv[1] ?? 'http://127.0.0.1:8787', '/');
$origin = 'http://127.0.0.1:8099';

$pass = 0;
$fail = 0;

function req(string $method, string $path, ?array $body = null, ?string $token = null, array $headers = []): array
{
    global $base, $origin;
    $ch = curl_init($base . $path);
    $h = ['Content-Type: application/json', 'Origin: ' . $origin];
    if ($token !== null) {
        $h[] = 'Authorization: Bearer ' . $token;
    }
    foreach ($headers as $k => $v) {
        $h[] = "$k: $v";
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => true,
        CURLOPT_HTTPHEADER => $h,
        CURLOPT_PROXY => '',
        CURLOPT_TIMEOUT => 20,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        return ['status' => 0, 'body' => null, 'headers' => '', 'err' => curl_error($ch)];
    }
    $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [
        'status' => $status,
        'headers' => substr($raw, 0, $hs),
        'body' => json_decode(substr($raw, $hs), true),
        'raw' => substr($raw, $hs),
    ];
}

/**
 * L'étirement du mot de passe, tel que le navigateur le fait.
 *
 * Le serveur ne reçoit jamais un mot de passe : il reçoit cette clé. La
 * recette doit donc faire exactement ce que fait `js/core/kdf.js`, sinon elle
 * teste un protocole qui n'existe pas.
 *
 * Le sel se dérive de l'adresse : le client doit pouvoir le calculer AVANT
 * d'être authentifié, donc le serveur ne peut pas le lui fournir. Un sel n'a
 * pas besoin d'être secret, seulement distinct d'un compte à l'autre.
 */
function derive(string $email, string $password): string
{
    static $cache = [];
    $k = $email . "\0" . $password;
    if (isset($cache[$k])) {
        return $cache[$k];
    }
    $salt = hash('sha256', 'grims-kdf-v1:' . mb_strtolower(trim($email)), true);
    return $cache[$k] = hash_pbkdf2('sha256', $password, $salt, 600000, 64);
}

function check(string $label, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
        echo "  ok   $label\n";
    } else {
        $fail++;
        echo "  ÉCHEC $label" . ($detail !== '' ? "  — $detail" : '') . "\n";
    }
}

function section(string $t): void
{
    echo "\n$t\n";
}

$mail = 'test+' . bin2hex(random_bytes(4)) . '@exemple.fr';
$pw = 'motdepasse';

/* Si le serveur testé exige une invitation, tout le déroulé principal doit la
 * présenter : le contrôle du code passe AVANT celui de l'adresse et du mot de
 * passe, donc sans lui chaque test d'inscription vérifierait la porte au lieu
 * de ce qu'il vise. La section 11 est la seule à l'omettre, exprès. */
$invite = getenv('GRIMS_INVITE') ?: '';
$withInvite = static fn (array $b): array => $GLOBALS['invite'] === ''
    ? $b : $b + ['invite' => $GLOBALS['invite']];

/* ========================================================================== */
section('1. Sonde et route inconnue');

$r = req('GET', '/api/health');
check('/api/health répond', $r['status'] === 200 && ($r['body']['ok'] ?? false) === true, "statut {$r['status']}");
/* La même recette sert aux deux implémentations — PHP/MySQL et Workers/D1 —
 * parce qu'elle est écrite au niveau HTTP et ne connaît que le contrat. */
echo "       moteur : " . ($r['body']['driver'] ?? '?')
    . ", exécution : " . ($r['body']['runtime'] ?? ('PHP ' . ($r['body']['php'] ?? '?'))) . "\n";

$r = req('GET', '/api/nawak');
check('route inconnue → JSON 404, pas du HTML', $r['status'] === 404 && ($r['body']['error'] ?? '') === 'not_found', $r['raw'] ?? '');

/* ========================================================================== */
section('2. CORS — l\'étape qu\'on oublie, et qui casse tout en production');

$ch = curl_init($base . '/api/auth/login');
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => 'OPTIONS',
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => true,
    CURLOPT_PROXY => '',
    CURLOPT_HTTPHEADER => ['Origin: ' . $origin, 'Access-Control-Request-Method: POST', 'Access-Control-Request-Headers: content-type, authorization'],
]);
$pre = (string) curl_exec($ch);
$preStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
check('préflight OPTIONS → 204', $preStatus === 204, "statut $preStatus");
check('Allow-Origin renvoie l\'origine demandée', stripos($pre, 'Access-Control-Allow-Origin: ' . $origin) !== false);
check('Allow-Headers contient Authorization', stripos($pre, 'authorization') !== false);

$r = req('GET', '/api/health', null, null, []);
check('origine inconnue → pas d\'Allow-Origin permissif', stripos($r['headers'], 'Allow-Origin: *') === false);

/* ========================================================================== */
section('3. Inscription');

$r = req('POST', '/api/auth/register', $withInvite(['email' => 'pas-une-adresse', 'password' => derive('pas-une-adresse', 'motdepasse')]));
check('adresse invalide → invalid_email', ($r['body']['error'] ?? '') === 'invalid_email', json_encode($r['body']));

/* Le serveur ne voit plus jamais un mot de passe : il ne peut donc plus en
 * vérifier la longueur — c'est le client qui la tient. Ce qu'il DOIT refuser,
 * en revanche, c'est un mot de passe brut : sans cette barrière, un client
 * ancien ou bricolé ferait stocker un vrai mot de passe derrière un hachage
 * bien trop court, et personne ne s'en apercevrait avant la fuite. */
$r = req('POST', '/api/auth/register', $withInvite(['email' => $mail, 'password' => 'motdepasse']));
check('mot de passe BRUT refusé → client_outdated', ($r['body']['error'] ?? '') === 'client_outdated', json_encode($r['body']));

$r = req('POST', '/api/auth/register', $withInvite(['email' => $mail, 'password' => str_repeat('z', 64)]));
check('clé mal formée (hexa invalide) refusée', ($r['body']['error'] ?? '') === 'client_outdated', json_encode($r['body']));

$r = req('POST', '/api/auth/register', $withInvite(['email' => $mail, 'password' => derive($mail, $pw), 'name' => "Grim's"]));
$tokenA = $r['body']['token'] ?? null;
check('inscription → jeton', $r['status'] === 200 && is_string($tokenA) && strlen($tokenA) === 64, json_encode($r['body']));
check('inscription → utilisateur complet', ($r['body']['user']['email'] ?? '') === $mail && ($r['body']['user']['name'] ?? '') === "Grim's");

$r = req('POST', '/api/auth/register', $withInvite(['email' => strtoupper($mail), 'password' => derive($mail, $pw)]));
check('même adresse en majuscules → email_taken', ($r['body']['error'] ?? '') === 'email_taken', json_encode($r['body']));

/* ========================================================================== */
section('4. Connexion');

$r = req('POST', '/api/auth/login', ['email' => $mail, 'password' => derive($mail, 'mauvais mot de passe')]);
check('mauvais mot de passe → bad_credentials 401', $r['status'] === 401 && ($r['body']['error'] ?? '') === 'bad_credentials');

$r = req('POST', '/api/auth/login', ['email' => 'inconnu@exemple.fr', 'password' => derive('inconnu@exemple.fr', 'mauvais')]);
check('adresse inconnue → MÊME code bad_credentials', ($r['body']['error'] ?? '') === 'bad_credentials', json_encode($r['body']));

$r = req('POST', '/api/auth/login', ['email' => $mail, 'password' => derive($mail, $pw)]);
$tokenB = $r['body']['token'] ?? null;
check('connexion → jeton (second appareil)', $r['status'] === 200 && is_string($tokenB));
check('les deux appareils ont des jetons distincts', $tokenA !== $tokenB);

$r = req('GET', '/api/sync/pull?since=0', null, 'jeton-bidon');
check('jeton invalide → 401', $r['status'] === 401 && ($r['body']['error'] ?? '') === 'unauthorized');

$r = req('GET', '/api/sync/pull?since=0', null, null);
check('sans jeton → 401', $r['status'] === 401);

/* ========================================================================== */
section('5. Synchronisation — un appareil');

$t0 = (int) (microtime(true) * 1000);
$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'catches', 'id' => 'c1', 'updatedAt' => $t0, 'deleted' => false,
        'data' => ['id' => 'c1', 't' => $t0, 'species' => 'bar', 'cm' => 62]],
    ['collection' => 'profile', 'id' => 'profile', 'updatedAt' => $t0, 'deleted' => false,
        'data' => ['updatedAt' => $t0, 'nom' => 'Grim\'s', 'sounderOffsetM' => 0.6]],
]], $tokenA);
check('push de deux enregistrements → applied 2', ($r['body']['applied'] ?? 0) === 2, json_encode($r['body']));

$r = req('GET', '/api/sync/pull?since=0', null, $tokenB);
$recs = $r['body']['records'] ?? [];
$now1 = $r['body']['serverNow'] ?? null;
check('le second appareil voit les deux', count($recs) === 2, 'reçu ' . count($recs));
check('l\'accent et l\'apostrophe survivent au trajet',
    ($recs[1]['data']['nom'] ?? '') === "Grim's", json_encode($recs[1]['data'] ?? null));
check('serverNow est rendu', is_int($now1) && $now1 > 0, var_export($now1, true));

$r = req('GET', '/api/sync/pull?since=' . $now1, null, $tokenB);
/* Le statut fait partie de l'assertion : sans lui, un 500 dont le corps est
 * `{"error":…}` passe pour « aucun enregistrement » et le test verdit sur une
 * panne. C'est arrivé ici même à la première exécution. */
check('même curseur → plus rien', $r['status'] === 200 && ($r['body']['records'] ?? null) === [], json_encode($r['body']));

/* ========================================================================== */
section('6. Conflit — dernier écrit gagne');

$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'catches', 'id' => 'c1', 'updatedAt' => $t0 - 5000, 'deleted' => false,
        'data' => ['id' => 'c1', 't' => $t0 - 5000, 'species' => 'maquereau', 'cm' => 30]],
]], $tokenB);
check('push plus ANCIEN → 0 appliqué', ($r['body']['applied'] ?? -1) === 0, json_encode($r['body']));

$r = req('GET', '/api/sync/pull?since=0', null, $tokenA);
$c1 = null;
foreach ($r['body']['records'] as $x) {
    if ($x['id'] === 'c1') {
        $c1 = $x;
    }
}
check('la valeur récente a tenu', ($c1['data']['species'] ?? '') === 'bar', json_encode($c1['data'] ?? null));

$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'catches', 'id' => 'c1', 'updatedAt' => $t0 + 5000, 'deleted' => false,
        'data' => ['id' => 'c1', 't' => $t0 + 5000, 'species' => 'bar', 'cm' => 71]],
]], $tokenB);
check('push plus RÉCENT → 1 appliqué', ($r['body']['applied'] ?? 0) === 1, json_encode($r['body']));

$r = req('GET', '/api/sync/pull?since=' . $now1, null, $tokenA);
$now2 = $r['body']['serverNow'];
$got = $r['body']['records'][0] ?? null;
check('l\'autre appareil reçoit la mise à jour', ($got['data']['cm'] ?? 0) === 71, json_encode($got['data'] ?? null));
check('le curseur a avancé', $now2 > $now1, "$now1 → $now2");

/* ========================================================================== */
section('7. Suppression — pierre tombale, pas effacement');

$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'catches', 'id' => 'c1', 'updatedAt' => $t0 + 9000, 'deleted' => true, 'data' => null],
]], $tokenA);
check('suppression acceptée', ($r['body']['applied'] ?? 0) === 1, json_encode($r['body']));

$r = req('GET', '/api/sync/pull?since=' . $now2, null, $tokenB);
$tomb = $r['body']['records'][0] ?? null;
$now3 = $r['body']['serverNow'];
check('la suppression REDESCEND (et n\'est pas juste absente)',
    ($tomb['id'] ?? '') === 'c1' && ($tomb['deleted'] ?? false) === true, json_encode($tomb));
/* Pas de `?? 'x'` ici : sur une valeur qui EST null, il rend la valeur par
 * défaut, et l'assertion ne peut plus distinguer « absent » de « null » —
 * précisément la distinction sur laquelle repose une pierre tombale. */
check('la tombe ne porte pas de données',
    is_array($tomb) && array_key_exists('data', $tomb) && $tomb['data'] === null, json_encode($tomb));

/* ========================================================================== */
section('8. Refus des entrées douteuses');

$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'nimportequoi', 'id' => 'x', 'updatedAt' => $t0, 'deleted' => false, 'data' => []],
]], $tokenA);
check('collection inconnue → bad_request', $r['status'] === 400 && ($r['body']['error'] ?? '') === 'bad_request');

$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'profile', 'id' => 'autre-chose', 'updatedAt' => $t0, 'deleted' => false, 'data' => []],
]], $tokenA);
check('blob avec un identifiant inattendu → bad_request', ($r['body']['error'] ?? '') === 'bad_request');

$r = req('POST', '/api/sync/push', ['changes' => [
    ['collection' => 'catches', 'id' => 'c9', 'updatedAt' => 0, 'deleted' => false, 'data' => []],
]], $tokenA);
check('updatedAt absent ou nul → bad_request', ($r['body']['error'] ?? '') === 'bad_request');

$r = req('POST', '/api/sync/push', ['changes' => 'pas un tableau'], $tokenA);
check('corps mal formé → 400, PAS 401', $r['status'] === 400, "statut {$r['status']}");

$r = req('GET', '/api/sync/pull?since=0', null, $tokenA);
$ids = array_column($r['body']['records'], 'id');
check('aucun des refus n\'a laissé de trace', !in_array('c9', $ids, true) && !in_array('autre-chose', $ids, true), implode(',', $ids));

/* ========================================================================== */
section('9. Mot de passe oublié');

$r = req('POST', '/api/auth/forgot', ['email' => $mail]);
check('sans expéditeur configuré → 501 (le client dit « pas en service »)', $r['status'] === 501, "statut {$r['status']}");

/* ========================================================================== */
section('10. Export, déconnexion, suppression du compte');

$r = req('GET', '/api/account/export', null, $tokenA);
check('export → tout le compte', $r['status'] === 200 && count($r['body']['records'] ?? []) >= 2, json_encode(array_column($r['body']['records'] ?? [], 'id')));

$r = req('POST', '/api/auth/logout', null, $tokenB);
check('déconnexion → ok', $r['status'] === 200);

$r = req('GET', '/api/sync/pull?since=0', null, $tokenB);
check('le jeton déconnecté ne vaut plus rien → 401', $r['status'] === 401);

$r = req('GET', '/api/sync/pull?since=0', null, $tokenA);
check('l\'autre appareil reste connecté', $r['status'] === 200);

$r = req('DELETE', '/api/account', null, $tokenA);
check('suppression du compte → ok', $r['status'] === 200 && ($r['body']['ok'] ?? false) === true);

$r = req('GET', '/api/sync/pull?since=0', null, $tokenA);
check('après suppression, le jeton est mort', $r['status'] === 401);

/* ========================================================================== */
section('11. Inscription sur invitation');

/* Ne s'exécute que si le serveur testé est configuré avec un code. Sur une
 * installation ouverte, ces vérifications n'ont pas d'objet — et un test qui
 * échoue « normalement » finit par ne plus être lu du tout. */
if ($invite === '') {
    echo "       (aucun code fourni — passez GRIMS_INVITE=… pour tester la porte)\n";
} else {
    /* La section 3 a déjà consommé le quota d'inscriptions de la minute, et
     * cette section-ci en demande quatre de plus. On attend plutôt que de
     * relever le plafond : cette limite est la seule chose qui rend inutile
     * l'essai systématique des codes d'invitation, elle ne s'assouplit pas
     * pour arranger un test. */
    echo "       attente de la fenêtre de limitation (61 s)…\n";
    sleep(61);

    $m2 = 'inv+' . bin2hex(random_bytes(4)) . '@exemple.fr';

    $r = req('POST', '/api/auth/register', ['email' => $m2, 'password' => derive($m2, $pw)]);
    check('sans code → invite_required 403',
        $r['status'] === 403 && ($r['body']['error'] ?? '') === 'invite_required', json_encode($r['body']));

    $r = req('POST', '/api/auth/register', ['email' => $m2, 'password' => derive($m2, $pw), 'invite' => 'pas-le-bon']);
    check('mauvais code → invite_invalid 403',
        $r['status'] === 403 && ($r['body']['error'] ?? '') === 'invite_invalid', json_encode($r['body']));

    /* La vérification qui compte vraiment : un refus ne doit pas avoir créé le
     * compte quand même. Une porte qui dit non mais laisse entrer est pire
     * qu'une porte ouverte — on croit être protégé. */
    $r = req('POST', '/api/auth/login', ['email' => $m2, 'password' => derive($m2, $pw)]);
    check('AUCUN compte n\'a été créé par les refus',
        ($r['body']['error'] ?? '') === 'bad_credentials', json_encode($r['body']));

    $r = req('POST', '/api/auth/register', ['email' => $m2, 'password' => derive($m2, $pw), 'invite' => $invite]);
    check('bon code → inscription acceptée', $r['status'] === 200 && !empty($r['body']['token']), json_encode($r['body']));

    $r = req('DELETE', '/api/account', null, $r['body']['token'] ?? null);
    check('ménage du compte de test', $r['status'] === 200);
}

/* ========================================================================== */
section('12. Limitation de débit (en dernier : elle bloque l\'adresse une minute)');

$codes = [];
for ($i = 0; $i < 9; $i++) {
    $codes[] = req('POST', '/api/auth/login', ['email' => 'brute@exemple.fr', 'password' => derive('brute@exemple.fr', 'essai' . $i)])['status'];
}
check('les essais répétés finissent en 429', in_array(429, $codes, true), implode(' ', $codes));
check('le blocage arrive vite (≤ 6 essais)', array_search(429, $codes, true) <= 6, implode(' ', $codes));

/* ========================================================================== */
echo "\n" . str_repeat('-', 60) . "\n";
echo ($fail === 0 ? "TOUT PASSE" : "ÉCHECS : $fail") . "   ($pass réussites)\n";
exit($fail === 0 ? 0 : 1);

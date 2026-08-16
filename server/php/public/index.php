<?php
/* ==========================================================================
 * index.php — point d'entrée unique
 * --------------------------------------------------------------------------
 * Tout arrive ici, y compris ce qui n'existe pas : le .htaccess réécrit
 * l'ensemble des URL vers ce fichier. C'est ce qui garantit qu'une route
 * inconnue rende du JSON, et pas la page 404 d'Apache — le client lit le
 * corps avant le statut, et une page HTML le fait tomber dans « Serveur
 * injoignable » alors que le serveur va parfaitement bien.
 * ========================================================================== */

declare(strict_types=1);

$root = dirname(__DIR__);
$src = is_dir($root . '/src') ? $root . '/src' : __DIR__ . '/src';

require $src . '/Http.php';
require $src . '/Db.php';
require $src . '/Auth.php';
require $src . '/Sync.php';

$cfgFile = is_file($root . '/config.php') ? $root . '/config.php' : __DIR__ . '/config.php';
if (!is_file($cfgFile)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'no_config']);
    exit;
}
$cfg = require $cfgFile;

Http::boot($cfg);
Http::cors();
Auth::configure($cfg);

/* --- Chemin demandé, indépendant du dossier d'installation ---------------- */
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
if ($base !== '' && str_starts_with($path, $base)) {
    $path = substr($path, strlen($base));
}
$path = '/' . ltrim($path, '/');
$path = rtrim($path, '/');
if ($path === '') {
    $path = '/';
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    Db::connect($cfg);

    switch ("$method $path") {
        /* Sonde de bon fonctionnement. C'est la première chose à ouvrir dans
         * un navigateur après un dépôt par FTP : si elle ne répond pas, rien
         * d'autre ne répondra, et on cherche du côté du .htaccess. */
        case 'GET /api/health':
            Http::json([
                'ok' => true,
                'driver' => Db::driver(),
                'php' => PHP_VERSION,
                'argon2id' => defined('PASSWORD_ARGON2ID'),
                'serverNow' => Db::currentSeq(),
            ]);
            // no break — Http::json termine la requête

        case 'POST /api/auth/register':
            Auth::register();

        case 'POST /api/auth/login':
            Auth::login();

        case 'POST /api/auth/logout':
            Auth::logout();

        case 'POST /api/auth/forgot':
            Auth::forgot();

        case 'GET /reset':
        case 'POST /reset':
            Auth::resetPage();

        case 'POST /api/sync/push':
            Sync::push(Auth::user());

        case 'GET /api/sync/pull':
            Sync::pull(Auth::user());

        case 'GET /api/account/export':
            Sync::export(Auth::user());

        case 'DELETE /api/account':
            Sync::deleteAccount(Auth::user());

        default:
            Http::fail('not_found', 404);
    }
} catch (Throwable $e) {
    /* Le détail part dans le journal du serveur, jamais dans la réponse : un
     * message d'erreur SQL rendu au client raconte le schéma à qui le demande.
     * Le client, lui, n'a besoin que de savoir que ça vient d'ici. */
    error_log('[grims] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Http::json(['error' => 'server_error'], 500);
}

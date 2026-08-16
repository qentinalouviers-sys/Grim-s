<?php
/* ==========================================================================
 * Http.php — entrée et sortie, CORS, erreurs
 * --------------------------------------------------------------------------
 * Tout ce que le client lit passe par ici. Une seule règle, tenue partout :
 * la réponse est TOUJOURS du JSON, y compris sur une erreur, y compris sur
 * une panne. Le client fait `res.json()` avant de regarder le statut ; une
 * page d'erreur HTML d'Apache le fait tomber dans le message générique
 * « Serveur injoignable », qui n'aide personne à comprendre.
 * ========================================================================== */

declare(strict_types=1);

final class Http
{
    /** Corps maximal accepté, en octets. Au-delà : 413, jamais une coupure. */
    public const MAX_BODY = 12 * 1024 * 1024;

    private static array $cfg = [];

    public static function boot(array $cfg): void
    {
        self::$cfg = $cfg;

        /* Une erreur PHP non rattrapée produirait du HTML. On les convertit
         * toutes en exceptions, et le routeur les rend en JSON. */
        set_error_handler(static function (int $no, string $msg, string $file, int $line): bool {
            if (!(error_reporting() & $no)) {
                return false;
            }
            throw new ErrorException($msg, 0, $no, $file, $line);
        });

        /* Le fatal (mémoire épuisée sur un gros carnet de sondes, par exemple)
         * échappe au try/catch. Sans ce filet, le client reçoit une page vide
         * et affiche « injoignable » alors que le serveur répond très bien. */
        register_shutdown_function(static function (): void {
            $e = error_get_last();
            if ($e !== null && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
                if (!headers_sent()) {
                    self::json(['error' => 'server_error'], 500);
                }
            }
        });
    }

    /* ----------------------------------------------------------------------
     * CORS
     * --------------------------------------------------------------------
     * L'app n'est pas servie par ce serveur : elle vit sur GitHub Pages ou sur
     * le domaine du propriétaire, et appelle l'API depuis une AUTRE origine.
     * Sans ces en-têtes, le navigateur bloque tout avant même l'envoi, et le
     * seul symptôme est « Failed to fetch » — aucune trace dans les journaux
     * du serveur, parce que la requête n'y arrive jamais.
     * -------------------------------------------------------------------- */
    public static function cors(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        $allowed = self::$cfg['origins'] ?? [];

        if ($origin !== '' && (in_array('*', $allowed, true) || in_array($origin, $allowed, true))) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin');
        }
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
        header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
        header('Access-Control-Max-Age: 86400');

        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    /** Réponse JSON, et fin de la requête. */
    public static function json(mixed $data, int $status = 200): never
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /** Erreur métier : un code machine que le client traduit lui-même. */
    public static function fail(string $code, int $status = 400): never
    {
        self::json(['error' => $code], $status);
    }

    /**
     * Corps de la requête, décodé.
     *
     * Le garde-fou de taille est avant le décodage : `json_decode` sur douze
     * mégaoctets consomme la mémoire d'abord et échoue ensuite, ce qui donne
     * un 500 opaque au lieu d'un 413 explicite.
     */
    public static function body(): array
    {
        $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($len > self::MAX_BODY) {
            self::fail('too_large', 413);
        }

        $raw = file_get_contents('php://input');
        if ($raw === false || $raw === '') {
            return [];
        }
        if (strlen($raw) > self::MAX_BODY) {
            self::fail('too_large', 413);
        }

        /* post_max_size dépassé : PHP vide le corps SANS erreur visible. On le
         * détecte ici, sinon le symptôme est un « bad_request » incompréhensible
         * dès qu'une trace de sortie dépasse la limite de l'hébergeur. */
        if ($len > 0 && $raw === '') {
            self::fail('too_large', 413);
        }

        $data = json_decode($raw, true);
        if (!is_array($data)) {
            self::fail('bad_request', 400);
        }
        return $data;
    }

    /**
     * Adresse du client, pour la limitation de débit.
     *
     * Chez OVH mutualisé comme derrière tout répartiteur, REMOTE_ADDR est
     * l'adresse du proxy : sans lire l'en-tête transmis, TOUT LE MONDE partage
     * le même compteur et le premier venu verrouille les autres. On ne fait
     * confiance à l'en-tête que si la configuration le déclare — sinon
     * n'importe qui contourne la limite en forgeant un X-Forwarded-For.
     */
    public static function ip(): string
    {
        if (!empty(self::$cfg['trust_proxy'])) {
            $fwd = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
            if ($fwd !== '') {
                $first = trim(explode(',', $fwd)[0]);
                if (filter_var($first, FILTER_VALIDATE_IP)) {
                    return $first;
                }
            }
        }
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    /** Le jeton porteur, ou null. */
    public static function bearer(): ?string
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';

        /* Apache en CGI n'expose pas Authorization dans $_SERVER. C'est le
         * piège classique de l'hébergement mutualisé : tout marche en local,
         * et en production chaque appel authentifié répond 401. Le .htaccess
         * fourni le remet, on le relit ici en second recours. */
        if ($h === '' && function_exists('apache_request_headers')) {
            foreach (apache_request_headers() as $k => $v) {
                if (strcasecmp($k, 'Authorization') === 0) {
                    $h = $v;
                    break;
                }
            }
        }
        if (preg_match('/^Bearer\s+(.+)$/i', trim($h), $m)) {
            return trim($m[1]);
        }
        return null;
    }
}

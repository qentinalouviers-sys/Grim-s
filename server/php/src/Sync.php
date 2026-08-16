<?php
/* ==========================================================================
 * Sync.php — pousser, tirer, exporter, supprimer
 * --------------------------------------------------------------------------
 * Le serveur n'est pas la source de vérité : l'app tourne entièrement sans
 * lui, et c'est IndexedDB qui fait foi sur le téléphone. Ce module n'est
 * qu'un dépôt partagé entre appareils, arbitré au « dernier écrit gagne ».
 *
 * Deux conséquences qui expliquent tout le reste du fichier :
 *   - une suppression se range en pierre tombale, jamais en effacement sec.
 *     Sinon effacer une prise sur le téléphone détruit la donnée de la
 *     tablette qui ne l'avait pas encore vue ;
 *   - une lecture partielle ne doit JAMAIS se présenter comme complète. Le
 *     client range le curseur rendu et ne revient jamais en arrière : ce qui
 *     est sauté est sauté pour de bon.
 * ========================================================================== */

declare(strict_types=1);

final class Sync
{
    /**
     * Les collections acceptées, et leur nature. La liste est fermée : un
     * client modifié pourrait sinon écrire n'importe quel nom et faire de ce
     * compte un espace de stockage libre.
     */
    private const COLLECTIONS = [
        'catches' => 'records',
        'spots' => 'records',
        'tracks' => 'records',
        'profile' => 'blob',
        'settings' => 'blob',
        'customSpecies' => 'blob',
        'driftObs' => 'blob',
        'soundings' => 'blob',
        'wxAlerts' => 'blob',
    ];

    /** Plafonds de lecture : nombre de lignes, puis poids cumulé. */
    private const PULL_ROWS = 2000;
    private const PULL_BYTES = 6 * 1024 * 1024;

    private const MAX_CHANGES = 5000;

    /* ======================================================================
     * POST /api/sync/push
     * ==================================================================== */
    public static function push(array $user): never
    {
        $b = Http::body();
        $changes = $b['changes'] ?? null;

        if (!is_array($changes)) {
            Http::fail('bad_request', 400);
        }
        if (count($changes) > self::MAX_CHANGES) {
            Http::fail('too_large', 413);
        }
        if ($changes === []) {
            Http::json(['applied' => 0]);
        }

        /* Tout valider AVANT d'écrire quoi que ce soit. Un lot à moitié appliqué
         * laisse le client persuadé que le reste est monté : il range son point
         * de reprise et ne repoussera jamais ce qui manque. */
        $clean = [];
        foreach ($changes as $c) {
            if (!is_array($c)) {
                Http::fail('bad_request', 400);
            }
            $col = (string) ($c['collection'] ?? '');
            $kind = self::COLLECTIONS[$col] ?? null;
            if ($kind === null) {
                Http::fail('bad_request', 400);
            }

            $id = (string) ($c['id'] ?? '');
            if ($id === '' || strlen($id) > 128) {
                Http::fail('bad_request', 400);
            }
            /* Pour un blob, l'identifiant EST le nom de la collection. Laisser
             * passer autre chose créerait des documents fantômes que le client
             * ne redescendra jamais, puisqu'il n'en connaît qu'un. */
            if ($kind === 'blob' && $id !== $col) {
                Http::fail('bad_request', 400);
            }

            $deleted = !empty($c['deleted']);
            $updatedAt = (int) ($c['updatedAt'] ?? 0);
            if ($updatedAt <= 0) {
                Http::fail('bad_request', 400);
            }

            $data = null;
            if (!$deleted) {
                if (!array_key_exists('data', $c) || $c['data'] === null) {
                    Http::fail('bad_request', 400);
                }
                $data = json_encode($c['data'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if ($data === false) {
                    Http::fail('bad_request', 400);
                }
            }

            $clean[] = [$col, $id, $updatedAt, $deleted, $data];
        }

        $pdo = Db::pdo();
        $applied = 0;

        /* La transaction ne sert pas qu'à l'atomicité du lot. Elle tient aussi
         * le verrou sur le compteur pendant l'écriture : une lecture menée en
         * parallèle voit l'ancienne valeur, donc son curseur s'arrête AVANT ces
         * lignes-là, et elles lui reviendront au tour suivant au lieu d'être
         * enjambées. */
        $pdo->beginTransaction();
        try {
            $base = Db::reserveSeq(count($clean)) - count($clean);
            $i = 0;
            foreach ($clean as [$col, $id, $updatedAt, $deleted, $data]) {
                if (Db::upsertRecord($user['id'], $col, $id, $updatedAt, $base + (++$i), $deleted, $data)) {
                    $applied++;
                }
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::json(['applied' => $applied]);
    }

    /* ======================================================================
     * GET /api/sync/pull?since=<curseur>
     * ==================================================================== */
    public static function pull(array $user): never
    {
        $since = (int) ($_GET['since'] ?? 0);
        if ($since < 0) {
            $since = 0;
        }

        /* Photographie du compteur AVANT la lecture, et borne haute de la
         * requête. Sans cette borne, une ligne écrite pendant la lecture peut
         * se glisser dans le résultat sans que le curseur rendu la couvre —
         * ou, pire, se retrouver au-dessous du curseur sans être lue. */
        $now = Db::currentSeq();

        $st = Db::pdo()->prepare(
            'SELECT collection, rec_id, updated_at, deleted, data, seq
               FROM records
              WHERE user_id = ? AND seq > ? AND seq <= ?
              ORDER BY seq
              LIMIT ' . self::PULL_ROWS
        );
        $st->execute([$user['id'], $since, $now]);

        $out = [];
        $bytes = 0;
        $last = null;
        $truncated = false;

        foreach ($st as $r) {
            $len = strlen((string) $r['data']);
            /* On coupe AVANT d'ajouter, et jamais sur la première ligne : un
             * carnet de sondes plus gros que le plafond doit passer quand même,
             * quitte à faire une réponse hors norme. Le refuser bloquerait la
             * synchro pour toujours, sans issue. */
            if ($out !== [] && $bytes + $len > self::PULL_BYTES) {
                $truncated = true;
                break;
            }
            $bytes += $len;
            $last = (int) $r['seq'];

            $out[] = [
                'collection' => $r['collection'],
                'id' => $r['rec_id'],
                'updatedAt' => (int) $r['updated_at'],
                'deleted' => ((int) $r['deleted']) === 1,
                'data' => $r['data'] === null ? null : json_decode((string) $r['data'], true),
            ];
        }

        if (count($out) >= self::PULL_ROWS) {
            $truncated = true;
        }

        /* Curseur rendu : la borne complète si tout est passé, sinon la
         * dernière ligne réellement envoyée. Annoncer la borne alors qu'on a
         * tronqué ferait perdre le reste en silence — c'est exactement le genre
         * de perte que personne ne remarque avant des mois. */
        Http::json([
            'serverNow' => $truncated && $last !== null ? $last : $now,
            'records' => $out,
            'more' => $truncated,
        ]);
    }

    /* ======================================================================
     * GET /api/account/export
     * ==================================================================== */
    public static function export(array $user): never
    {
        $st = Db::pdo()->prepare(
            'SELECT collection, rec_id, updated_at, deleted, data FROM records WHERE user_id = ? ORDER BY collection, rec_id'
        );
        $st->execute([$user['id']]);

        $records = [];
        foreach ($st as $r) {
            $records[] = [
                'collection' => $r['collection'],
                'id' => $r['rec_id'],
                'updatedAt' => (int) $r['updated_at'],
                'deleted' => ((int) $r['deleted']) === 1,
                'data' => $r['data'] === null ? null : json_decode((string) $r['data'], true),
            ];
        }

        header('Content-Disposition: attachment; filename="grims-export.json"');
        Http::json(['user' => $user, 'exportedAt' => (int) (microtime(true) * 1000), 'records' => $records]);
    }

    /* ======================================================================
     * DELETE /api/account
     * ==================================================================== */
    public static function deleteAccount(array $user): never
    {
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            foreach (['records', 'tokens', 'resets'] as $t) {
                $pdo->prepare("DELETE FROM $t WHERE user_id = ?")->execute([$user['id']]);
            }
            $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$user['id']]);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        Http::json(['ok' => true]);
    }
}

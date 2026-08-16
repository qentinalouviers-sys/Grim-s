<?php
/* ==========================================================================
 * Db.php — connexion, schéma, curseur de synchronisation
 * --------------------------------------------------------------------------
 * Deux moteurs, volontairement :
 *
 *   sqlite  pour développer sur son ordinateur. Zéro installation : un
 *           fichier, `php -S`, et l'app se connecte. On peut donc tout
 *           vérifier AVANT de payer un hébergement.
 *   mysql   pour la production sur mutualisé, où le stockage est en réseau
 *           et où un fichier SQLite partagé finit par se corrompre sous deux
 *           écritures simultanées. Un carnet de sondes relevé sortie après
 *           sortie ne se retéléchargera jamais : ce risque-là ne se prend pas.
 *
 * Le code métier ne sait pas lequel tourne. Les trois seules différences —
 * type du champ texte long, syntaxe de l'upsert, auto-incrément — sont ici.
 * ========================================================================== */

declare(strict_types=1);

final class Db
{
    private static ?PDO $pdo = null;
    private static string $driver = 'sqlite';

    public static function connect(array $cfg): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        $dsn = $cfg['db']['dsn'] ?? '';
        if ($dsn === '') {
            Http::fail('server_error', 500);
        }

        self::$driver = strtok($dsn, ':') ?: 'sqlite';

        if (self::$driver === 'sqlite') {
            $path = substr($dsn, 7);
            $dir = dirname($path);
            if ($dir !== '' && !is_dir($dir)) {
                @mkdir($dir, 0770, true);
            }
        }

        self::$pdo = new PDO($dsn, $cfg['db']['user'] ?? null, $cfg['db']['pass'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);

        if (self::$driver === 'sqlite') {
            /* WAL : les lectures ne bloquent plus l'écriture. Sans lui, deux
             * onglets ouverts pendant un développement suffisent à produire
             * un « database is locked » qui ressemble à une panne réseau. */
            self::$pdo->exec('PRAGMA journal_mode = WAL');
            self::$pdo->exec('PRAGMA busy_timeout = 5000');
            self::$pdo->exec('PRAGMA foreign_keys = ON');
        } else {
            self::$pdo->exec("SET NAMES utf8mb4");
        }

        self::migrate();
        return self::$pdo;
    }

    public static function pdo(): PDO
    {
        return self::$pdo;
    }

    public static function driver(): string
    {
        return self::$driver;
    }

    /* ----------------------------------------------------------------------
     * Schéma
     * --------------------------------------------------------------------
     * Créé à la demande, à chaque requête, en CREATE TABLE IF NOT EXISTS. Sur
     * mutualisé il n'y a ni console ni tâche de déploiement : demander à
     * l'utilisateur d'importer un .sql par phpMyAdmin avant que ça marche,
     * c'est une étape de plus qui se rate en silence. Le coût est une poignée
     * de requêtes triviales par appel.
     * -------------------------------------------------------------------- */
    private static function migrate(): void
    {
        $my = self::$driver === 'mysql';
        $txt = $my ? 'LONGTEXT' : 'TEXT';
        $eng = $my ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
        $pk = $my ? 'BIGINT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

        self::$pdo->exec("
            CREATE TABLE IF NOT EXISTS users (
                id          VARCHAR(32)  NOT NULL PRIMARY KEY,
                email       VARCHAR(190) NOT NULL,
                email_key   VARCHAR(190) NOT NULL,
                pass_hash   VARCHAR(255) NOT NULL,
                name        VARCHAR(120) NULL,
                created_at  BIGINT       NOT NULL,
                fail_count  INTEGER      NOT NULL DEFAULT 0,
                locked_until BIGINT      NOT NULL DEFAULT 0
            )$eng");
        self::$pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_key ON users (email_key)');

        self::$pdo->exec("
            CREATE TABLE IF NOT EXISTS tokens (
                token_hash   CHAR(64)    NOT NULL PRIMARY KEY,
                user_id      VARCHAR(32) NOT NULL,
                created_at   BIGINT      NOT NULL,
                expires_at   BIGINT      NOT NULL,
                last_used_at BIGINT      NOT NULL
            )$eng");
        self::$pdo->exec('CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id)');

        /* `updated_at` vient du client et sert à trancher les conflits.
         * `seq` vient du serveur et sert de curseur de lecture. Les confondre
         * est la faute classique de ce genre de synchro : un téléphone dont
         * l'horloge retarde de dix minutes pousse une prise datée dans le
         * passé, elle se range AVANT le curseur des autres appareils, et
         * personne ne la voit jamais redescendre. Deux colonnes, deux rôles. */
        self::$pdo->exec("
            CREATE TABLE IF NOT EXISTS records (
                user_id    VARCHAR(32)  NOT NULL,
                collection VARCHAR(40)  NOT NULL,
                rec_id     VARCHAR(128) NOT NULL,
                updated_at BIGINT       NOT NULL,
                seq        BIGINT       NOT NULL,
                deleted    TINYINT      NOT NULL DEFAULT 0,
                data       $txt         NULL,
                PRIMARY KEY (user_id, collection, rec_id)
            )$eng");
        self::$pdo->exec('CREATE INDEX IF NOT EXISTS idx_records_seq ON records (user_id, seq)');

        self::$pdo->exec("
            CREATE TABLE IF NOT EXISTS resets (
                token_hash VARCHAR(64)  NOT NULL PRIMARY KEY,
                user_id    VARCHAR(32)  NOT NULL,
                created_at BIGINT       NOT NULL,
                expires_at BIGINT       NOT NULL,
                used_at    BIGINT       NOT NULL DEFAULT 0
            )$eng");

        self::$pdo->exec("
            CREATE TABLE IF NOT EXISTS attempts (
                id     $pk,
                ip     VARCHAR(45) NOT NULL,
                action VARCHAR(20) NOT NULL,
                at     BIGINT      NOT NULL
            )$eng");
        self::$pdo->exec('CREATE INDEX IF NOT EXISTS idx_attempts ON attempts (ip, action, at)');

        self::$pdo->exec("
            CREATE TABLE IF NOT EXISTS counters (
                name VARCHAR(20) NOT NULL PRIMARY KEY,
                v    BIGINT      NOT NULL
            )$eng");

        $ins = $my
            ? 'INSERT IGNORE INTO counters (name, v) VALUES (?, 0)'
            : 'INSERT OR IGNORE INTO counters (name, v) VALUES (?, 0)';
        self::$pdo->prepare($ins)->execute(['seq']);
    }

    /* ----------------------------------------------------------------------
     * Curseur
     * --------------------------------------------------------------------
     * Un entier qui ne recule jamais, alloué par le serveur. On réserve un
     * bloc de `$n` valeurs d'un coup : sans ça, un envoi de deux mille sondes
     * fait deux mille allers-retours sur la même ligne, et chacun attend le
     * verrou du précédent.
     *
     * Pourquoi pas l'horloge du serveur ? Parce que deux écritures dans la
     * même milliseconde partagent alors la même valeur, et qu'une lecture au
     * curseur « strictement supérieur » en saute une définitivement.
     * -------------------------------------------------------------------- */
    public static function reserveSeq(int $n): int
    {
        $pdo = self::$pdo;
        $pdo->prepare('UPDATE counters SET v = v + ? WHERE name = ?')->execute([$n, 'seq']);
        $st = $pdo->prepare('SELECT v FROM counters WHERE name = ?');
        $st->execute(['seq']);
        return (int) $st->fetchColumn();
    }

    /** Valeur courante du curseur, sans rien consommer. */
    public static function currentSeq(): int
    {
        $st = self::$pdo->prepare('SELECT v FROM counters WHERE name = ?');
        $st->execute(['seq']);
        return (int) $st->fetchColumn();
    }

    /**
     * Écriture d'un enregistrement, avec arbitrage last-write-wins DANS la
     * requête : la comparaison et l'écriture sont atomiques. Fait en deux
     * temps (lire, comparer, écrire), deux appareils qui poussent la même
     * prise à la même seconde se marchent dessus et le plus ancien gagne une
     * fois sur deux.
     */
    public static function upsertRecord(
        string $userId,
        string $collection,
        string $recId,
        int $updatedAt,
        int $seq,
        bool $deleted,
        ?string $data
    ): bool {
        $sql = self::$driver === 'mysql'
            ? 'INSERT INTO records (user_id, collection, rec_id, updated_at, seq, deleted, data)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE
                 updated_at = IF(VALUES(updated_at) > records.updated_at, VALUES(updated_at), records.updated_at),
                 seq        = IF(VALUES(updated_at) > records.updated_at, VALUES(seq),        records.seq),
                 deleted    = IF(VALUES(updated_at) > records.updated_at, VALUES(deleted),    records.deleted),
                 data       = IF(VALUES(updated_at) > records.updated_at, VALUES(data),       records.data)'
            : 'INSERT INTO records (user_id, collection, rec_id, updated_at, seq, deleted, data)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (user_id, collection, rec_id) DO UPDATE SET
                 updated_at = excluded.updated_at,
                 seq        = excluded.seq,
                 deleted    = excluded.deleted,
                 data       = excluded.data
               WHERE excluded.updated_at > records.updated_at';

        $st = self::$pdo->prepare($sql);
        $st->execute([$userId, $collection, $recId, $updatedAt, $seq, $deleted ? 1 : 0, $data]);

        /* rowCount ne dit pas la même chose des deux côtés : MySQL rend 2 pour
         * une mise à jour effective, 1 pour une insertion, 0 quand rien n'a
         * bougé ; SQLite rend 1 ou 0. On ne compare donc pas à une constante. */
        return $st->rowCount() > 0;
    }
}

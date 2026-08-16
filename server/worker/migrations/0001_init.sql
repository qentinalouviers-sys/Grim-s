-- ==========================================================================
-- 0001_init — le schéma de départ
-- --------------------------------------------------------------------------
-- Appliqué par `wrangler d1 migrations apply`, depuis GitHub Actions. Ne
-- jamais modifier ce fichier une fois déployé : une migration déjà appliquée
-- n'est pas rejouée, donc un changement ici ne partirait nulle part et les
-- deux bases divergeraient en silence. Toute évolution passe par un 0002.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS users (
    id           TEXT    NOT NULL PRIMARY KEY,
    email        TEXT    NOT NULL,
    email_key    TEXT    NOT NULL,
    pass_hash    TEXT    NOT NULL,
    name         TEXT,
    created_at   INTEGER NOT NULL,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
);

-- SQLite compare les textes octet par octet : sans cette clé normalisée en
-- minuscules, « Jean@… » et « jean@… » seraient deux comptes distincts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_key ON users (email_key);

CREATE TABLE IF NOT EXISTS tokens (
    token_hash   TEXT    NOT NULL PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);

-- `updated_at` vient du client et sert à trancher les conflits.
-- `seq` vient du serveur et sert de curseur de lecture.
-- Les confondre est la faute classique de ce genre de synchronisation : un
-- téléphone dont l'horloge retarde pousse une donnée sous le curseur des
-- autres appareils, et plus personne ne la voit.
CREATE TABLE IF NOT EXISTS records (
    user_id    TEXT    NOT NULL,
    collection TEXT    NOT NULL,
    rec_id     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    data       TEXT,
    PRIMARY KEY (user_id, collection, rec_id)
);

-- Sert deux fois : la lecture au curseur, et le calcul de MAX(seq) par compte
-- au moment de l'écriture. Sans lui, chaque envoi balaierait toute la table.
CREATE INDEX IF NOT EXISTS idx_records_seq ON records (user_id, seq);

CREATE TABLE IF NOT EXISTS resets (
    token_hash TEXT    NOT NULL PRIMARY KEY,
    user_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attempts (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ip     TEXT    NOT NULL,
    action TEXT    NOT NULL,
    at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts (ip, action, at);

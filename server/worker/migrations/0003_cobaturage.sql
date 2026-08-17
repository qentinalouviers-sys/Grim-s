-- ==========================================================================
-- 0003_cobaturage — sorties partagées, demandes de place, avis
-- --------------------------------------------------------------------------
-- Ce que ces tables NE contiennent pas est aussi important que le reste :
-- aucun poste de pêche. Une sortie porte un port de départ, jamais la marque
-- où l'on compte poser. Les postes relevés au sondeur restent la propriété de
-- celui qui les a trouvés, et une sortie partagée n'est pas une raison de les
-- publier.
--
-- Aucun montant encaissé non plus. L'app ne touche pas à l'argent : elle
-- calcule un plafond, la participation se règle entre les personnes, à bord.
-- Encaisser ferait de l'app un intermédiaire de paiement — d'autres
-- obligations, et un partage qui devient une transaction.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS trips (
    id          TEXT    NOT NULL PRIMARY KEY,
    captain_id  TEXT    NOT NULL,

    port        TEXT    NOT NULL,
    lat         REAL,
    lon         REAL,
    departs_at  INTEGER NOT NULL,     -- ms
    hours       REAL    NOT NULL,
    seats       INTEGER NOT NULL,
    fishing     TEXT,                 -- type de pêche envisagé
    notes       TEXT,

    -- Frais recevables, en centimes. Chacun est un poste que la SORTIE a
    -- coûté ; l'assurance annuelle et l'entretien n'ont pas de colonne, et
    -- c'est délibéré — ce sont des charges de propriétaire.
    cost_fuel_c INTEGER NOT NULL DEFAULT 0,
    cost_port_c INTEGER NOT NULL DEFAULT 0,
    cost_bait_c INTEGER NOT NULL DEFAULT 0,
    cost_food_c INTEGER NOT NULL DEFAULT 0,

    -- Le plafond par personne, RECALCULÉ par le serveur à l'écriture. Stocké
    -- pour être affiché sans refaire le calcul, jamais accepté du client.
    share_c     INTEGER NOT NULL,

    status      TEXT    NOT NULL DEFAULT 'open',   -- open | cancelled
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trips_when ON trips (departs_at);
CREATE INDEX IF NOT EXISTS idx_trips_captain ON trips (captain_id);

CREATE TABLE IF NOT EXISTS bookings (
    id         TEXT    NOT NULL PRIMARY KEY,
    trip_id    TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled
    message    TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER NOT NULL DEFAULT 0
);
-- Une seule demande par personne et par sortie : sans cette contrainte, un
-- appui répété sur un réseau lent en crée trois, et le capitaine voit la même
-- personne trois fois dans sa liste.
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_once ON bookings (trip_id, user_id);
CREATE INDEX IF NOT EXISTS idx_book_trip ON bookings (trip_id);
CREATE INDEX IF NOT EXISTS idx_book_user ON bookings (user_id);

CREATE TABLE IF NOT EXISTS reviews (
    id         TEXT    NOT NULL PRIMARY KEY,
    trip_id    TEXT    NOT NULL,
    author_id  TEXT    NOT NULL,
    target_id  TEXT    NOT NULL,
    -- Le rôle de la personne NOTÉE : on ne mélange pas la note d'un capitaine
    -- et celle d'un équipier. On n'attend pas la même chose des deux, et une
    -- moyenne unique effacerait la différence.
    role       TEXT    NOT NULL,      -- captain | crew
    stars      INTEGER NOT NULL,
    comment    TEXT,
    created_at INTEGER NOT NULL
);
-- Un avis par personne, par sortie, par cible. Rien n'empêcherait sinon
-- d'enfoncer quelqu'un en publiant dix fois une étoile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_once ON reviews (trip_id, author_id, target_id);
CREATE INDEX IF NOT EXISTS idx_rev_target ON reviews (target_id);

-- ==========================================================================
-- 0002_suspension — suspendre un compte
-- --------------------------------------------------------------------------
-- Fichier séparé, et pas une modification de 0001 : une migration déjà
-- appliquée n'est jamais rejouée. Retoucher 0001 ne partirait nulle part, et
-- la base de production divergerait du dépôt en silence — le pire des deux,
-- parce que rien ne le signale.
--
-- La suspension ne détruit rien. Le compte cesse de fonctionner, ses données
-- restent : une suspension se lève, et lever une suppression est impossible.
-- ==========================================================================

ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;

-- Motif et date, pour que la décision reste explicable dans six mois. Un
-- compte coupé sans raison notée devient un mystère pour celui qui reprend
-- l'administration — y compris soi-même.
ALTER TABLE users ADD COLUMN suspended_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN suspended_reason TEXT;

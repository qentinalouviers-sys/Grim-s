<?php
/* ==========================================================================
 * config.sample.php — modèle de configuration
 * --------------------------------------------------------------------------
 * Copiez ce fichier en `config.php` et remplissez-le. `config.php` est ignoré
 * par git : il contient le mot de passe de la base, il n'a rien à faire dans
 * un dépôt, même privé.
 * ========================================================================== */

return [
    /* ----------------------------------------------------------------------
     * Base de données
     * --------------------------------------------------------------------
     * En développement, sur votre ordinateur — rien à installer :
     *
     *   'dsn' => 'sqlite:' . __DIR__ . '/data/grims.sqlite',
     *
     * En production chez OVH mutualisé, les quatre valeurs sont dans l'espace
     * client, onglet « Bases de données » de l'hébergement. Le serveur n'est
     * PAS « localhost » chez OVH : c'est un nom du genre
     * `monbasexyz.mysql.db`, et s'y tromper donne un « server_error » muet.
     * -------------------------------------------------------------------- */
    'db' => [
        'dsn' => 'sqlite:' . __DIR__ . '/data/grims.sqlite',
        // 'dsn'  => 'mysql:host=xxxxxxx.mysql.db;dbname=xxxxxxx;charset=utf8mb4',
        'user' => null,
        'pass' => null,
    ],

    /* ----------------------------------------------------------------------
     * Origines autorisées
     * --------------------------------------------------------------------
     * L'app n'est pas servie par ce serveur : elle appelle depuis une autre
     * origine, et le navigateur exige que celle-ci soit nommée ici. Une
     * origine, c'est le schéma + le domaine + le port, sans barre finale.
     *
     * Ne mettez PAS '*' en production. Cela autoriserait n'importe quel site
     * ouvert dans le même navigateur à parler à cette API — les jetons ne
     * transitent pas par les cookies, donc le risque est mesuré, mais il n'y
     * a aucune raison de l'accepter.
     * -------------------------------------------------------------------- */
    'origins' => [
        'http://localhost:8099',
        'http://127.0.0.1:8099',
        // 'https://qentinalouviers-sys.github.io',
        // 'https://grims.eviatek.fr',
    ],

    /* ----------------------------------------------------------------------
     * Courriel
     * --------------------------------------------------------------------
     * Tant que ces deux valeurs sont vides, `/api/auth/forgot` répond 501 et
     * l'app affiche franchement « la réinitialisation n'est pas encore en
     * service » — plutôt qu'une erreur qui ferait chercher une faute de frappe.
     *
     * `mail_from` doit être une adresse DU DOMAINE hébergé. Un expéditeur en
     * @gmail.com envoyé depuis un serveur OVH part directement en indésirable,
     * quand il n'est pas rejeté.
     *
     * `public_url` est l'adresse publique de CE serveur : elle sert à composer
     * le lien de réinitialisation reçu par courriel.
     * -------------------------------------------------------------------- */
    'mail_from' => '',
    'public_url' => '',

    /* ----------------------------------------------------------------------
     * Derrière un répartiteur (c'est le cas chez OVH mutualisé)
     * --------------------------------------------------------------------
     * À true, la limitation de débit lit X-Forwarded-For au lieu de l'adresse
     * du proxy. Sans ça, tous les visiteurs partagent un même compteur et le
     * premier venu verrouille les autres.
     *
     * À laisser sur false en local, et partout où rien ne garantit que
     * l'en-tête est posé par le répartiteur : sinon n'importe qui contourne la
     * limitation en le forgeant lui-même.
     * -------------------------------------------------------------------- */
    'trust_proxy' => false,
];

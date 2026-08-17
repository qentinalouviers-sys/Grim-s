# L'API en PHP — installer, vérifier, déployer

Implémentation complète de `server/auth-sync.md` : comptes, jetons,
synchronisation, export, suppression de compte, réinitialisation du mot de
passe. Aucune bibliothèque à installer, aucun `composer`, aucun `npm` — du PHP
8 et une base de données.

> **L'implémentation retenue est celle de `server/worker/`**, sur Cloudflare
> Workers, parce qu'elle se pilote entièrement depuis le dépôt. Celle-ci reste
> maintenue et testée par la même recette : elle sert de solution de repli et
> de seconde lecture du contrat. Les deux parlent **le même protocole** — le
> champ `password` porte une clé dérivée par le navigateur, jamais un mot de
> passe (voir la section 0 bis du contrat) — donc un compte créé sur l'une
> s'ouvre sur l'autre.
>
> **Une exception, assumée : l'administration.** Le panneau d'administration
> et la suspension de compte (`/api/me`, `/api/admin/*`, colonne `suspended`)
> n'existent que côté Workers. Les ajouter ici doublerait une surface
> sensible — droits, suspension, écriture sur les comptes — pour une
> implémentation qui ne tourne nulle part. Si vous basculez un jour sur ce
> serveur-ci, il faudra les porter : la recette de contrat, elle, passe sur les
> deux et ne couvre pas ces routes.

Elle tourne sur **SQLite** pour développer et sur **MySQL** en production. Le
code métier ignore lequel des deux est en dessous : seul `config.php` change.

---

## 1. Essayer sur son ordinateur, sans rien payer

C'est l'étape à faire en premier. Elle ne demande ni hébergement, ni nom de
domaine, ni base de données.

```sh
cd server/php
cp config.sample.php config.php          # le modèle est déjà réglé sur SQLite
php -S 127.0.0.1:8787 -t public public/index.php
```

Ouvrez `http://127.0.0.1:8787/api/health`. Vous devez lire :

```json
{"ok":true,"driver":"sqlite","php":"8.4.…","argon2id":true,"serverNow":0}
```

Puis lancez la recette — quarante-quatre vérifications, dans l'ordre où chacune
suppose la précédente :

```sh
php tests/acceptance.php http://127.0.0.1:8787
```

Enfin, branchez la vraie application dessus. Servez le dépôt
(`python3 -m http.server 8099`), ouvrez la console du navigateur et tapez :

```js
localStorage.setItem('grimsApiBase', 'http://127.0.0.1:8787');
location.reload();
```

Inscrivez-vous depuis l'écran de compte. Tout doit fonctionner : c'est le même
code qui tournera en production.

Pour revenir au serveur normal : `localStorage.removeItem('grimsApiBase')`.

---

## 2. Déposer chez OVH mutualisé

### a. Le sous-domaine

Espace client → **Domaines** → votre domaine → **Zone DNS** → ajouter un
enregistrement **A** nommé `grims` vers l'IP de votre hébergement (elle est sur
la page de l'hébergement). Puis **Hébergements** → **Multisite** → ajouter
`grims.mondomaine.fr` en pointant vers un dossier, par exemple `grims`.

Cochez la génération du certificat SSL. **HTTPS n'est pas facultatif** : le
client envoie le mot de passe dans le corps de la requête, et c'est TLS qui le
protège — il n'y a rien d'autre.

La propagation DNS prend de quelques minutes à quelques heures.

### b. Les fichiers

Par FTP, dans le dossier du sous-domaine :

```
grims/
  index.php          ← public/index.php
  .htaccess          ← public/.htaccess
  .user.ini          ← public/.user.ini
  config.php         ← votre copie remplie
  src/               ← src/ en entier, .htaccess compris
```

Le `.htaccess` de `src/` interdit de servir ce dossier. Il compte : sans lui,
`config.php` et les sources sont téléchargeables par n'importe qui.

> Vérifiez-le une fois en production, en ouvrant
> `https://grims.mondomaine.fr/src/Db.php` dans un navigateur. Vous devez
> obtenir une erreur 403. Si le code s'affiche, arrêtez tout : le mot de passe
> de votre base est public.

### c. La base

Espace client → **Hébergements** → **Bases de données** → en créer une. Notez
les quatre valeurs et reportez-les dans `config.php` :

```php
'db' => [
    'dsn'  => 'mysql:host=xxxxxxx.mysql.db;dbname=xxxxxxx;charset=utf8mb4',
    'user' => 'xxxxxxx',
    'pass' => '……',
],
```

Le serveur n'est **pas** `localhost` chez OVH : c'est un nom du genre
`monbasexyz.mysql.db`. S'y tromper donne un `server_error` sans autre
explication — c'est l'erreur la plus fréquente de cette étape.

Rien à importer : les tables se créent toutes seules au premier appel.

### d. Les origines

Dans `config.php`, listez les origines depuis lesquelles l'app est servie :

```php
'origins' => [
    'https://qentinalouviers-sys.github.io',
    'https://grims.mondomaine.fr',
],
'trust_proxy' => true,   // OVH est derrière un répartiteur
```

Une origine, c'est le schéma + le domaine + le port, **sans barre finale**.
Oublier cette liste est la panne classique : `curl` fonctionne parfaitement, le
navigateur affiche « Failed to fetch », et rien n'apparaît dans les journaux du
serveur — parce que la requête n'y arrive jamais.

### e. Vérifier

```sh
php tests/acceptance.php https://grims.mondomaine.fr
```

La recette crée un compte de test et le supprime à la fin. Elle vérifie aussi
le CORS et le passage de l'en-tête `Authorization`, qui sont précisément les
deux choses qui marchent en local et cassent en production.

Enfin, dans l'app : `localStorage.setItem('grimsApiBase', 'https://grims.mondomaine.fr')`,
ou modifiez la valeur par défaut dans `js/core/sync.js`.

---

## 3. Le courriel

Tant que `mail_from` et `public_url` sont vides, `/api/auth/forgot` répond 501
et l'app affiche franchement « la réinitialisation n'est pas encore en
service ». Rien n'est cassé : la fonction est simplement absente.

Pour l'activer :

```php
'mail_from'  => 'grims@mondomaine.fr',
'public_url' => 'https://grims.mondomaine.fr',
```

L'adresse d'expédition doit appartenir au domaine hébergé. Un expéditeur en
`@gmail.com` envoyé depuis un serveur OVH part en indésirable quand il n'est
pas purement rejeté.

> Sans cette route, un mot de passe perdu est un compte perdu définitivement.
> C'est la fonction manquante la plus grave du lot — à activer avant que
> quelqu'un d'autre que vous ne crée un compte.

---

## 4. Ce que ce serveur ne fait pas

- **Il n'envoie pas encore les alertes météo.** Le contrat est dans
  `server/wx-alerts.md`. Les règles montent bien dans la collection `wxAlerts`
  et attendent l'outil qui les relira ; il reste à l'écrire.
- **Il ne fait pas la présence de flotte** (`server/presence.md`).
- **Il ne sauvegarde rien tout seul.** Il devient dépositaire de carnets de
  sondes relevés à bord, sortie après sortie, qui ne se retéléchargent
  d'aucune façon. Le mutualisé OVH propose une sauvegarde de base de données :
  activez-la, ou exportez régulièrement par phpMyAdmin.
- **Il ne pagine pas côté client.** Une lecture rend au plus 2000
  enregistrements ou 6 Mo, et signale la troncature par `more: true`. Le client
  actuel ignore ce drapeau et rattrapera au tour suivant, cinq minutes plus
  tard. Un compte très fourni met donc quelques tours à descendre la première
  fois — sans jamais rien perdre, le curseur rendu ne dépassant pas ce qui a
  réellement été envoyé.

---

## 5. Deux détails qui coûtent une soirée si on les ignore

**`Authorization` disparaît en CGI.** Apache en FastCGI — c'est le cas chez OVH
— ne transmet pas cet en-tête à PHP. Tout marche en local, et en production
chaque appel authentifié répond 401. La règle `RewriteRule` en tête du
`.htaccess` le remet ; `Http::bearer()` sait aussi le relire par un second
chemin.

**Les limites de taille sont muettes.** Au-delà de `post_max_size`, PHP vide le
corps de la requête sans lever d'erreur : le symptôme est un `bad_request`
incompréhensible sur un carnet de sondes un peu gros, jamais un message parlant
de taille. C'est le rôle du `.user.ini`. Chez OVH il peut mettre quelques
minutes à être pris en compte.

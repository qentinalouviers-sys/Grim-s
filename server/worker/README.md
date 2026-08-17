# L'API sur Cloudflare Workers + D1

Implémentation de `server/auth-sync.md` en modules ES, sans étape de build.
Jumelle de `server/php/` : **même contrat, même recette, même protocole**. Un
compte créé sur l'une s'ouvre sur l'autre.

Tout ce qui décrit l'infrastructure est dans ce dossier — le service, la base,
les origines autorisées, les migrations. Il n'y a rien à cliquer dans un
panneau, donc tout se relit, se compare et se corrige par un commit.

---

## 1. Essayer sur son ordinateur, sans compte Cloudflare

```sh
cd server/worker
npm install
npm run migrate:local
npm run dev            # http://127.0.0.1:8788
```

`wrangler dev --local` fait tourner le vrai moteur de Cloudflare (workerd) et
une vraie base D1, entièrement hors ligne. Ce n'est pas une imitation : c'est
le même code qu'en production.

La recette :

```sh
php ../php/tests/acceptance.php http://127.0.0.1:8788
```

Quarante-cinq vérifications. C'est **le même fichier** qui sert à valider la
version PHP : il est écrit au niveau HTTP et ne connaît que le contrat, jamais
l'implémentation. Deux serveurs, une seule définition de ce qui est correct.

Pour brancher l'application dessus :

```js
localStorage.setItem('grimsApiBase', 'http://127.0.0.1:8788');
location.reload();
```

---

## 2. Mettre en service

Deux gestes manuels, une seule fois chacun. Tout le reste passe ensuite par des
commits.

**a. Créer la base.**

```sh
npx wrangler login
npx wrangler d1 create grims
```

Recopiez le `database_id` rendu dans `wrangler.toml`.

**b. Déposer les secrets** dans *Settings → Secrets and variables → Actions* du
dépôt GitHub :

| secret | où le trouver |
|---|---|
| `CLOUDFLARE_API_TOKEN` | tableau de bord Cloudflare → My Profile → API Tokens, modèle « Edit Cloudflare Workers », auquel il faut **ajouter `D1 : Edit`** |
| `CLOUDFLARE_ACCOUNT_ID` | page d'accueil du tableau de bord, colonne de droite |

Ne prenez pas un jeton global. Celui-ci ne doit pouvoir toucher qu'à cette API :
si un jour il fuit, il ne doit pas emporter le domaine avec lui.

**c. Fermer l'inscription**, si l'API n'a pas vocation à accueillir des
inconnus :

```sh
npx wrangler secret put INVITE_CODE
```

Sans ce secret, l'inscription est **ouverte** : qui connaît l'adresse de l'API
peut se créer un compte. Il ne lira les données de personne — chaque requête
est filtrée par compte, et ce filtre est dans la requête elle-même, pas dans
une politique d'accès qu'on pourrait oublier de poser — mais il occupera la
place dans la base, et il apparaîtra sur la carte de flotte le jour où elle
existera.

Avec le secret, l'app découvre le champ « code d'invitation » seulement après
un refus du serveur : sur une installation ouverte, elle ne demande rien.

Ensuite, `.github/workflows/deploy-api.yml` applique les migrations puis déploie
à chaque poussée sur la branche par défaut qui touche à `server/worker/`.

Renseignez aussi la variable `API_URL` (*Settings → Variables → Actions*) avec
l'adresse du Worker : le workflow appelle alors `/api/health` après chaque
déploiement. Sans elle, un déploiement qui rend un 500 à chaque appel passerait
pour réussi.

---

## 3. Le mot de passe, et pourquoi il est étiré dans le navigateur

C'est la seule vraie différence de conception avec la version PHP, et elle
mérite d'être comprise avant d'être modifiée.

L'offre gratuite de Workers accorde **10 ms de temps processeur par requête**.
Or un hachage de mot de passe est coûteux par construction — c'est toute sa
fonction. Mesuré, en PBKDF2-SHA256 :

| tours | coût |
|---|---|
| 10 000 | 6,5 ms — déjà au bord |
| 25 000 | 12 ms — dépassé |
| 210 000 | 95 ms |
| 600 000 | 273 ms — la recommandation courante |

Il n'existe donc pas de réglage qui tienne à la fois dans le budget et dans les
règles de l'art. Baisser le nombre de tours reviendrait à publier des mots de
passe à peine protégés — et ce sont des mots de passe que leurs propriétaires
réutilisent à la banque et sur leur messagerie.

Le calcul change donc de machine : **le téléphone étire, et n'envoie que le
résultat** (`js/core/kdf.js`). Le serveur ne voit jamais le mot de passe.

Ce que cela donne face à une copie volée de la base : pour tester un mot de
passe, l'attaquant doit refaire les 600 000 tours. Le facteur de travail
recommandé est bien là, il a seulement déménagé. Et l'empreinte volée ne permet
pas de se connecter : le serveur exige la clé, pas son empreinte.

Trois conséquences à connaître :

- **HTTPS reste obligatoire.** La clé voyage en clair dans le corps de la
  requête et vaut mot de passe pour qui l'intercepte — exactement comme un mot
  de passe. L'étirement ne remplace pas TLS, il ne l'a jamais prétendu.
- **Le serveur ne peut plus vérifier la longueur du mot de passe**, puisqu'il
  ne le reçoit pas. C'est l'écran de compte qui la tient. Quelqu'un qui
  contournerait l'app pour se donner un mot de passe d'un caractère n'exposerait
  que son propre compte.
- **Le serveur refuse tout ce qui n'a pas la forme d'une clé** (`client_outdated`).
  Sans cette barrière, un client ancien ou bricolé ferait stocker un vrai mot de
  passe derrière un hachage bien trop court, et personne ne s'en apercevrait
  avant la fuite.

Mesuré dans Chromium sur un profil iPhone 12 : **268 ms**. Sur un téléphone
réel plus ancien, comptez autour de la seconde. L'écran affiche « Chiffrement… »
pendant ce temps, plutôt que « Connexion… » — sinon on cherche un problème de
réseau là où il n'y en a pas.

---

## 4. Le curseur de synchronisation

`updated_at` vient du client et sert à trancher les conflits. `seq` vient du
serveur et sert de curseur de lecture. **Les confondre perd des données en
silence**, de deux façons distinctes :

- avec `updatedAt`, un téléphone dont l'horloge retarde de dix minutes pousse
  une prise datée dans le passé : elle se range *avant* le curseur des autres
  appareils, qui ne la voient jamais redescendre ;
- avec l'heure du serveur, deux écritures dans la même milliseconde partagent
  la même valeur, et une lecture « strictement supérieure » en saute une.

Ici, `seq` vaut `MAX(seq) + 1` **par compte**, calculé dans la requête
d'écriture elle-même. SQLite sérialise les écritures : deux envois simultanés
ne peuvent donc ni obtenir le même numéro, ni s'intercaler sous le curseur
d'une lecture déjà servie. Il n'y a aucune fenêtre à refermer, parce qu'il n'y
en a jamais eu.

Et la lecture ne rend jamais un curseur plus loin que ce qu'elle a réellement
envoyé — c'est ce qui rend une lecture tronquée inoffensive plutôt que fatale.

---

## 5. Ce qui n'est pas fait

- **Les alertes météo par courriel** (`server/wx-alerts.md`). Les règles montent
  déjà dans la collection `wxAlerts` ; il manque la tâche périodique qui les
  relit, interroge la météo et envoie le message. Un déclencheur `[triggers]`
  dans `wrangler.toml` et un gestionnaire `scheduled` suffiront — mais tant que
  ce n'est pas écrit, mieux vaut ne rien déclarer qu'une tâche qui ne fait rien.
- **La présence de flotte** (`server/presence.md`).
- **L'envoi du courriel de réinitialisation.** Le code est là et attend trois
  valeurs : `MAIL_FROM`, `PUBLIC_URL` et le secret `SMTP_KEY`. Tant qu'elles
  manquent, la route répond 501 et l'app affiche franchement « pas encore en
  service ». Un Worker n'ayant pas de sockets bruts, l'envoi passe par l'API
  HTTP d'un service transactionnel, pas par SMTP.

  > Sans cette route, un mot de passe perdu est un compte perdu définitivement.
  > C'est la fonction manquante la plus grave du lot.
- **Les sauvegardes.** Cette base devient dépositaire de carnets de sondes
  relevés à bord, sortie après sortie, qui ne se retéléchargent d'aucune façon.
  `npx wrangler d1 export grims --remote --output sauvegarde.sql`, régulièrement.

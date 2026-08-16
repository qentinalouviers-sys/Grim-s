# Compte et synchronisation — le contrat serveur

Le client est livré et complet dans `js/core/sync.js` et `js/ui/account.js`. Il
appelle `API_BASE` — `https://grims.eviatek.fr` par défaut, surchargeable en
développement par `localStorage.grimsApiBase`.

Ce document décrit **exactement** ce que le serveur doit répondre. Les codes
d'erreur ne sont pas indicatifs : le client les traduit en français un par un,
et un code inconnu tombe dans un message générique qui n'aide personne.

Tant que ces routes n'existent pas, l'app fonctionne intégralement en local et
l'écran de compte affiche « Serveur injoignable ». Rien n'est perdu : la
synchronisation est un plus, jamais un socle.

---

## 0. Règles générales

- **Toujours du JSON**, y compris sur les erreurs : `{"error": "code_machine"}`.
  Le client lit `error` avant le statut HTTP.
- **HTTPS obligatoire.** Le client envoie un mot de passe en clair dans le
  corps ; c'est TLS qui le protège, il n'y a rien d'autre.
- **Le serveur fait foi sur l'heure.** Les horodatages venus du client servent
  à ordonner ses propres enregistrements, jamais à décider d'une expiration.
- **CORS** : l'app est servie depuis une autre origine (GitHub Pages ou le
  domaine du propriétaire). Il faut `Access-Control-Allow-Origin` sur cette
  origine, `Allow-Headers: Content-Type, Authorization`, et répondre aux
  requêtes `OPTIONS`. Sans ça tout échoue en `Failed to fetch`, sans autre
  indice — c'est le premier symptôme à vérifier.
- **Délai** : le client abandonne à 15 s.

---

## 1. `POST /api/auth/register`

```json
{ "email": "toi@exemple.fr", "password": "……", "name": "Grim's" }
```

`name` est facultatif et peut être `null`.

**200**
```json
{ "token": "……", "user": { "id": "u_…", "email": "toi@exemple.fr", "name": "Grim's" } }
```

**Erreurs attendues** — le client a un message pour chacune :

| code | quand |
|---|---|
| `invalid_email` | adresse mal formée |
| `weak_password` | moins de 8 caractères |
| `email_taken` | un compte existe déjà |
| `rate_limited` | trop de tentatives depuis cette adresse IP |

Le mot de passe se hache avec **argon2id** ou **bcrypt** (coût ≥ 12). Jamais
de SHA seul, jamais en clair, jamais réversible : ce fichier de comptes
contiendra des mots de passe réutilisés ailleurs par leurs propriétaires.

**Minimum huit caractères**, comme le client le vérifie déjà. Ne pas exiger de
majuscule ni de caractère spécial : ces règles produisent des mots de passe
plus courts et notés sur un papier.

---

## 2. `POST /api/auth/login`

```json
{ "email": "toi@exemple.fr", "password": "……" }
```

**200** : même forme que `register`.

| code | quand |
|---|---|
| `bad_credentials` | e-mail inconnu **ou** mot de passe faux |
| `rate_limited` | trop de tentatives |
| `account_locked` | verrouillage après trop d'échecs |

**Un seul code pour les deux cas de `bad_credentials`**, et c'est important :
répondre « cet e-mail n'existe pas » permet à n'importe qui de savoir qui a un
compte. Le délai de réponse doit être comparable dans les deux cas, sinon la
mesure du temps le révèle quand même.

---

## 3. `POST /api/auth/logout`

Authentifiée. Invalide le jeton courant. **204** ou `{"ok":true}`.

Le client l'appelle mais **n'attend pas sa réussite** : quelqu'un qui veut se
déconnecter dans un parking sans réseau doit pouvoir le faire. Si la route
n'existe pas, la déconnexion locale a quand même lieu.

---

## 4. `POST /api/auth/forgot`

```json
{ "email": "toi@exemple.fr" }
```

**200** — **toujours**, que le compte existe ou non. Le client affiche « si un
compte existe pour cet e-mail, un lien vient de partir ». Répondre 404 sur un
e-mail inconnu révélerait qui a un compte.

Envoie un lien à usage unique, valable une heure, vers une page web du serveur
qui demande le nouveau mot de passe. **Ce n'est pas l'app qui gère la
réinitialisation** : elle n'a pas de routage d'URL profondes.

**501 ou 404** tant que ce n'est pas en service : le client le reconnaît et
affiche « la réinitialisation n'est pas encore en service sur le serveur »,
plutôt qu'une erreur qui ferait croire à une faute de frappe.

> Sans cette route, un mot de passe perdu est un compte perdu définitivement.
> C'est la fonction manquante la plus grave de tout le lot.

---

## 5. Le jeton

`Authorization: Bearer <token>` sur toutes les routes authentifiées.

**Le 401 a un sens précis pour le client** : il efface la session locale et
affiche un bandeau « session expirée ». Ne réponds donc 401 **que** pour un
jeton invalide, expiré ou révoqué — pas pour un corps mal formé (400), pas
pour un droit manquant (403), pas pour une panne (500). Un 401 rendu par erreur
déconnecte l'utilisateur.

Durée de vie : longue. Un jeton d'une heure obligerait à se reconnecter en mer,
sans réseau, avec les mains mouillées. **Trente à quatre-vingt-dix jours**,
prolongé à chaque synchro réussie, est le bon ordre de grandeur pour cet usage.

---

## 6. `POST /api/sync/push`

```json
{ "changes": [
  { "collection": "catches", "id": "c123", "updatedAt": 1786810000000,
    "deleted": false, "data": { … } }
] }
```

**200** → `{ "applied": 12 }`

Collections envoyées, et leur nature :

| collection | type | contenu |
|---|---|---|
| `catches` | records | les prises |
| `spots` | records | les marques personnelles |
| `tracks` | records | les traces de sortie |
| `profile` | blob | la fiche bateau |
| `settings` | blob | les réglages |
| `customSpecies` | blob | les espèces libres |
| `driftObs` | blob | les relevés de dérive |
| `soundings` | blob | **le carnet de sondes** |
| `wxAlerts` | blob | les alertes météo |

*records* : chaque `id` est une entité. *blob* : un seul document dont l'`id`
vaut le nom de la collection, remplacé en entier.

**Last-write-wins sur `updatedAt`** — et c'est la règle des deux côtés. Le
serveur ne garde un changement que s'il est strictement plus récent que ce
qu'il a. Une suppression arrive avec `deleted: true` et `data: null` : elle se
range en **tombstone**, jamais en effacement sec, sinon un effacement fait sur
un téléphone détruit la donnée d'un autre appareil qui ne l'a pas encore vue.

**Taille** : un carnet de sondes de trois ans ou une trace de sortie complète
peuvent faire plusieurs mégaoctets. Accepter au moins 10 Mo par requête, et
répondre **413** avec `{"error":"too_large"}` plutôt que de couper la
connexion.

---

## 7. `GET /api/sync/pull?since=<ms>`

**200**
```json
{
  "serverNow": 1786810000000,
  "records": [
    { "collection": "spots", "id": "s42", "updatedAt": 1786809000000,
      "deleted": false, "data": { … } }
  ]
}
```

Tout ce qui a changé **strictement après** `since`, pour ce compte uniquement.
`since=0` au premier appel : renvoyer alors tout le compte.

`serverNow` est réutilisé tel quel comme `since` du tour suivant. C'est un
**curseur opaque** : le client ne l'interprète jamais, il le range et le rend.

> **Correction apportée par l'implémentation** (`server/php/`, et à reprendre
> dans toute autre). Ce document disait d'y mettre l'heure du serveur. C'est
> faux sur deux points, et les deux perdent des données en silence :
>
> - **`updatedAt` ne peut pas servir de curseur.** Il vient du client et sert à
>   trancher les conflits. Un téléphone dont l'horloge retarde de dix minutes
>   pousse une prise datée dans le passé : elle se range *avant* le curseur des
>   autres appareils, et aucun ne la verra jamais redescendre.
> - **L'heure du serveur ne suffit pas non plus.** Deux écritures dans la même
>   milliseconde partagent la même valeur, et une lecture « strictement
>   supérieure » en saute une définitivement.
>
> Il faut donc **deux colonnes** : `updated_at`, venue du client, pour
> l'arbitrage ; et un entier serveur strictement croissant, alloué à
> l'écriture, pour le curseur. L'implémentation PHP utilise un compteur
> incrémenté dans la transaction d'écriture, ce qui ferme aussi la fenêtre où
> une ligne en cours d'écriture pourrait être enjambée par une lecture
> simultanée.

**Pagination** : si le compte est gros, renvoyer par tranches avec un
`serverNow` correspondant à la tranche. Le client rappellera. Ne jamais
tronquer en silence : un `pull` incomplet qui prétend être complet fait perdre
des données sans que personne le voie.

---

## 8. Ce qu'il faut aussi, et qui ne se voit pas

- **Limitation de débit** sur `login`, `register` et `forgot` : sans elle, la
  liste des mots de passe courants passe en quelques heures. Cinq tentatives
  par minute et par IP, plus un verrou progressif par compte.
- **Suppression du compte.** Obligation légale, et de toute façon la moindre
  des choses. Une route `DELETE /api/account` qui efface tout, plus l'export
  des données — le client sait déjà exporter en local, mais la copie serveur
  doit pouvoir partir aussi.
- **Sauvegardes.** Ce serveur devient le dépositaire de carnets de sondes qui
  ne se retéléchargent pas : ils ont été mesurés à bord, sortie après sortie.
  Les perdre, c'est les perdre pour de bon.
- **Journalisation sans mots de passe ni positions.** Les traces contiennent
  les postes de pêche de gens qui n'ont pas envie de les publier.

---

## 9. Vérifier que ça marche

Dans l'ordre, parce que chaque étape suppose la précédente :

1. `curl -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"a@b.fr","password":"motdepasse"}'` → un `token` ;
2. le même appel une seconde fois → `{"error":"email_taken"}` ;
3. `login` avec un mauvais mot de passe → `{"error":"bad_credentials"}` ;
4. `push` d'une prise, puis `pull?since=0` → elle revient ;
5. `pull` avec le `serverNow` du tour précédent → **rien** ;
6. un appel authentifié avec un jeton bidon → **401** ;
7. depuis un navigateur sur l'origine de l'app → aucune erreur CORS.

L'étape 7 est celle qu'on oublie, et c'est celle qui casse tout en production
alors que `curl` passe parfaitement.

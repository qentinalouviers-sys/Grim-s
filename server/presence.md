# Route `/api/presence` — la flotte

Le client est livré et fonctionnel dans l'application (`js/core/presence.js`).
Il lui manque cette route côté serveur, sur la même API que la
synchronisation — celle que `js/core/sync.js` appelle sur `API_BASE`
(`https://grims-api.qentina-louviers.workers.dev` par défaut).

Tant que la route n'existe pas, l'app ne montre **rien** : pas d'onglet vide,
pas d'erreur en boucle. Le client tente une fois, reçoit un 404, et se tait
pour la session. C'est la même règle que pour la carte des fonds ou les
épaves : une donnée absente n'invente pas une fonction.

---

## Contrat

Toutes les routes sont authentifiées par le même `Authorization: Bearer <token>`
que la synchronisation. L'identité du bateau vient du **compte**, jamais du
corps de la requête : sinon n'importe qui publie sous le nom du voisin.

### `POST /api/presence`

Publie ou rafraîchit la position du bateau connecté.

```json
{
  "lat": 49.98213,
  "lon": 1.04891,
  "sogKn": 4.2,
  "cogDeg": 317,
  "level": "sea",
  "distress": null,
  "boat": {
    "boatName": "Grim's",
    "hull": "semi-rigide",
    "lengthM": 6.5,
    "propulsion": "hors-bord-4t",
    "fishing": ["leurres", "palangrotte"]
  },
  "at": 1786810000000
}
```

- `level` ∈ `port` | `sea`. Le client ne poste jamais en `off`.
- `distress` ∈ `null` | `"mob"` | `"sos"`.
- `at` est l'horloge du téléphone : **ne pas s'y fier**. Le serveur fait foi et
  réécrit avec sa propre heure. Un téléphone mal réglé ne doit pas pouvoir
  faire disparaître son bateau de la liste, ni y rester après coup.

Réponse : `204`, ou `{ "ok": true }`.

### `GET /api/presence?lat=..&lon=..&radiusNM=30`

Renvoie les bateaux à portée, **sauf le demandeur**.

```json
{
  "serverNow": 1786810000000,
  "boats": [
    {
      "id": "b_7fc2",
      "lat": 49.9712,
      "lon": 1.0355,
      "sogKn": 0.4,
      "cogDeg": 210,
      "distress": null,
      "at": 1786809970000,
      "boat": { "boatName": "Ma Coquille", "hull": "coque-dure", "lengthM": 7.2 }
    }
  ]
}
```

- `id` est un identifiant **stable et opaque** — surtout pas l'adresse e-mail
  ni l'identifiant de compte.
- Ne renvoyer que les positions de moins de **15 minutes**. Le client filtre
  aussi, mais un serveur qui sert du périmé fait afficher un bateau là où il
  n'est plus, et en mer c'est pire que rien.

### `DELETE /api/presence`

Retire immédiatement la position du bateau connecté. Appelé quand
l'utilisateur repasse en « Invisible ». Doit être **immédiat** : c'est une
demande de disparaître, elle ne se met pas en file d'attente.

---

## Ce que le serveur doit garantir

1. **Rien n'est archivé.** Une seule ligne par bateau, écrasée à chaque envoi.
   Pas d'historique de positions — l'app n'en a pas besoin, et un journal de
   trajets de pêcheurs est exactement ce qu'il ne faut pas constituer. Purge
   des lignes de plus de 15 minutes.

2. **`level` est appliqué côté serveur aussi.** Le client filtre déjà, mais un
   client modifié ne doit pas pouvoir publier une position hauturière sous le
   niveau `port`. Si `level = "port"` et que le point est à plus de 2 milles
   de Dieppe, refuser ou ignorer.

3. **Le drapeau de détresse n'est pas un jouet.** `distress` non nul rend le
   bateau visible de tous, à n'importe quelle distance. Limiter à quelques
   envois par heure et par compte.

4. **Pas de position exacte dans les journaux du serveur.** Tronquer à trois
   décimales dans les logs, ou ne rien journaliser du tout.

---

## Schéma minimal (PostgreSQL / Supabase)

```sql
create table presence (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  lat        double precision not null,
  lon        double precision not null,
  sog_kn     real,
  cog_deg    smallint,
  level      text not null check (level in ('port','sea')),
  distress   text check (distress in ('mob','sos')),
  boat       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Balayage par secteur. À cette échelle — quelques dizaines de bateaux sur la
-- Manche orientale — un index simple sur updated_at suffit largement ; PostGIS
-- serait de l'artillerie pour un moineau.
create index on presence (updated_at desc);

-- Purge : tout ce qui dépasse le quart d'heure n'est plus une position, c'est
-- un souvenir.
create policy "lecture des positions fraîches" on presence
  for select using (updated_at > now() - interval '15 minutes');
```

Et le balayage périodique, à passer en tâche planifiée :

```sql
delete from presence where updated_at < now() - interval '1 hour';
```

---

## Vérifier le client sans serveur

Le client se teste en pointant l'API sur un bouchon local :

```js
localStorage.setItem('grimsApiBase', 'http://127.0.0.1:8787');
```

Un serveur de trente lignes qui répond `{ boats: [...] }` sur
`GET /api/presence` suffit à voir la couche s'afficher, les fiches s'ouvrir et
la navigation vers un bateau démarrer. C'est comme ça que la couche a été
vérifiée avant livraison.

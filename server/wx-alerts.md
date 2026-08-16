# Alertes météo par mail — l'outil de fond

Le client est livré et fonctionnel dans l'application. L'utilisateur règle ses
conditions (`js/ui/wxalertform.js`), elles sont enregistrées en local et
**remontent déjà par la synchronisation existante** — collection blob
`wxAlerts`, même mécanique que `settings` ou `driftObs`, aucune route nouvelle
à écrire pour les recevoir.

Il manque la moitié serveur : **un travail périodique qui relit ces règles,
interroge la météo et envoie le mail.** C'est le seul moyen d'être prévenu sans
ouvrir l'app — le but même de la fonction.

En attendant, l'app évalue les mêmes règles en local à chaque rafraîchissement
météo et prévient par notification. Rien ne casse tant que l'outil n'existe
pas ; il manque seulement le mail, et l'écran le dit à l'utilisateur en toutes
lettres au lieu de le lui promettre.

---

## 1. Ce qui arrive déjà côté serveur

À chaque synchro, le client pousse un enregistrement :

```json
{
  "collection": "wxAlerts",
  "id": "wxAlerts",
  "updatedAt": 1786810000000,
  "deleted": false,
  "data": [
    {
      "id": "a1m2k3x400",
      "name": "Sortie ≤ 12 nd / 0.8 m",
      "windMaxKn": 12,
      "gustMaxKn": 18,
      "waveMaxM": 0.8,
      "minHours": 3,
      "needSun": false,
      "noRain": true,
      "daylightOnly": true,
      "seaTempMinC": null,
      "days": [5, 6, 0],
      "horizonDays": 7,
      "channels": { "email": true, "push": true },
      "placeId": "fecamp",
      "placeName": "Fécamp",
      "lat": 49.7594,
      "lon": 0.3772,
      "enabled": true,
      "createdAt": 1786800000000,
      "updatedAt": 1786810000000,
      "notifiedFor": 1786896000000
    }
  ]
}
```

Le tableau est **la liste complète** des alertes du compte : une alerte
supprimée disparaît du tableau, il n'y a pas de tombstone par règle.

`days` : `null` = tous les jours ; sinon les jours de la semaine au sens
JavaScript, **dimanche = 0**.

`notifiedFor` : début (ms epoch) de la dernière fenêtre déjà annoncée, quel que
soit le canal. Voir §4 — c'est la clé de l'anti-doublon.

---

## 2. Le travail périodique

Une fois par heure suffit largement. Les modèles météo d'Open-Meteo sont
rafraîchis toutes les une à trois heures : passer plus souvent consomme du
quota sans rien apprendre de neuf.

```
pour chaque compte ayant au moins une alerte enabled avec channels.email :
    grouper ses alertes par (lat, lon) arrondis à 0.01°
    pour chaque position :
        prévision = Open-Meteo forecast + marine, 7 jours, timezone=auto
        pour chaque alerte de ce groupe :
            fenêtres = évaluer(alerte, prévision)
            si fenêtres[0] et non déjà annoncée :
                envoyer le mail
                notifiedFor = fenêtres[0].start
                réécrire la collection wxAlerts du compte
```

Regrouper par position n'est pas un détail : trois alertes sur Fécamp ne
doivent faire qu'un appel météo, pas trois. Open-Meteo est gratuit et sans clé,
mais il compte les requêtes, et un service qui se fait limiter cesse d'alerter
exactement quand il y a du monde.

### Les deux appels

Mêmes endpoints que le client (`js/data/weather.js`), mêmes variables :

```
https://api.open-meteo.com/v1/forecast
  ?latitude=..&longitude=..&timezone=auto&forecast_days=7
  &hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,
          temperature_2m,precipitation,cloud_cover,visibility

https://marine-api.open-meteo.com/v1/marine
  ?latitude=..&longitude=..&timezone=auto&forecast_days=7
  &hourly=wave_height,wave_period,wave_direction,wind_wave_height,
          swell_wave_height,sea_surface_temperature
```

Les vitesses de vent reviennent en **km/h** : diviser par 1,852 pour les nœuds.
C'est la conversion que le client applique, et un facteur différent des deux
côtés produirait des mails qui ne correspondent pas à ce que l'app affiche.

---

## 3. La règle d'évaluation

**Elle doit être identique au client, au sens strict.** La référence est
`hourPasses()` et `windows()` dans `js/core/wxalert.js` ; ce qui suit en est la
transcription, pas une reformulation.

Une **heure passe** si toutes ces conditions tiennent :

| condition | test |
|---|---|
| vent | `windSpeedKn ≤ windMaxKn` |
| rafales | `gustMaxKn == null` ou `windGustKn ≤ gustMaxKn` |
| mer | `waveMaxM == null` ou (`waveHeightM` **présent** et `≤ waveMaxM`) |
| pluie | `!noRain` ou `precipMm ≤ 0.2` |
| soleil | `!needSun` ou `cloudPct ≤ 40` |
| eau | `seaTempMinC == null` ou `seaTempC ≥ seaTempMinC` |
| jour | `!daylightOnly` ou `lever − 30 min ≤ t ≤ coucher + 30 min` |
| jour de semaine | `days == null` ou `days` contient `getDay()` local |

Deux pièges, et ce sont les seuls qui font vraiment diverger les deux moteurs :

- **Une mer absente ne passe pas.** Si `waveMaxM` est posé et que le modèle
  marin ne couvre pas le point, l'heure est rejetée. On ne sait pas, et « je ne
  sais pas » ne doit pas déclencher une sortie. Ne jamais remplacer par zéro.
- **Le jour de la semaine et les heures de jour sont LOCAUX au port**, pas UTC.
  D'où `timezone=auto` dans les deux appels.

Une **fenêtre** est une suite d'heures consécutives qui passent, d'au moins
`max(2, minHours)` heures. Sa fin est le **bout** de la dernière heure retenue :
une fenêtre de 09 h à 11 h dure trois heures, pas deux. Seules les heures dans
`[maintenant − 30 min, maintenant + horizonDays × 24 h]` comptent.

---

## 4. Ne pas envoyer deux fois

`notifiedFor` porte le début de la dernière fenêtre annoncée. Avant d'envoyer :

```
si notifiedFor et |notifiedFor − fenêtre.start| < 1 h : ne rien envoyer
```

Le champ est **partagé avec le client**, et c'est intentionnel : l'app et le
serveur regardent la même prévision, trouvent la même fenêtre, et ne doivent
pas la signaler chacun de son côté. Après un envoi, réécrire la collection
`wxAlerts` du compte avec un `updatedAt` neuf pour que la valeur redescende à
la synchro suivante.

Une seule alerte à la fois par règle : sept jours de beau temps ne doivent pas
produire sept mails identiques. C'est la **prochaine** fenêtre qu'on annonce,
pas toutes.

---

## 5. Le mail

Court. Il est lu sur un téléphone, souvent debout.

**Objet** — `🌤 Fenêtre météo à Fécamp — samedi 22 de 07 h à 13 h`

**Corps** — la fenêtre, ses chiffres, la règle qui l'a déclenchée, et un lien
vers l'app. Rien d'autre : pas de bulletin complet, pas de conseil de pêche.
Celui qui veut le détail ouvre l'app, et c'est le but du lien.

```
Ta règle « Sortie ≤ 12 nd / 0.8 m » est satisfaite.

Samedi 22 novembre, de 07:00 à 13:00 — 6 heures
Vent 9 nd max (rafales 14), mer 0.6 m max
Port : Fécamp

Voir le détail heure par heure : https://…/#nav

Tu reçois ce message parce que tu as créé cette alerte dans Grim's Compagnon.
Se désabonner de cette alerte : https://…
```

Le lien de désabonnement n'est pas décoratif : il conditionne la délivrabilité,
et un mail automatique sans moyen d'arrêt finit en spam pour tout le monde, y
compris les alertes des autres comptes.

### Ce qu'il faut côté envoi

- domaine authentifié — SPF, DKIM, DMARC. Sans ça, Gmail jette silencieusement ;
- adresse d'expéditeur dédiée, pas celle du support ;
- une file avec réessai : une alerte perdue parce que le relais SMTP toussait
  trente secondes est une alerte perdue pour de bon, la fenêtre ne revient pas ;
- un plafond par compte et par jour. Une règle très permissive — vent ≤ 25 nd,
  pas de mer, deux heures — trouve une fenêtre chaque jour. Trois mails par
  compte et par jour est un plafond raisonnable ; au-delà, empiler dans un seul
  message plutôt que d'en supprimer.

---

## 6. Ce qu'il ne faut pas faire

- **Ne pas envoyer d'alerte de mauvais temps depuis cette route.** L'utilisateur
  a demandé qu'on le prévienne quand c'est BON. Un avertissement de coup de vent
  est un autre produit, avec d'autres obligations : s'il croit être prévenu des
  tempêtes parce qu'un mail est arrivé une fois, il sortira en comptant dessus.
- **Ne pas déduire les conditions d'un score de pêche.** La règle porte sur des
  seuils physiques que l'utilisateur a posés. Y mêler un indice d'activité
  ferait sonner l'alerte pour des raisons qu'il n'a pas demandées et qu'il ne
  peut pas relire.
- **Ne pas faire confiance à `at` ou à un horodatage venu du client** pour
  décider d'un envoi. Le serveur fait foi sur l'heure, comme pour la présence.
- **Ne rien envoyer aux comptes dont `channels.email` est faux**, même si la
  fenêtre existe. Le canal est un choix, pas une préférence d'affichage.

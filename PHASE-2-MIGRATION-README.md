# BatBot — Phase 2 : préparation PostgreSQL et sessions partagées

Cette phase prépare BatBot à quitter progressivement SQLite pour une architecture adaptée au scaling horizontal.

## Ce qui est activé immédiatement

- `server.js` peut utiliser PostgreSQL pour les **sessions** lorsque `DATABASE_URL` est définie.
- Sans `DATABASE_URL`, BatBot conserve le stockage SQLite actuel : aucun changement de comportement en production tant que PostgreSQL n'est pas configuré.
- Le pool PostgreSQL est limité par `DATABASE_POOL_SIZE` (10 par défaut) afin d'éviter de multiplier les connexions lors d'un futur scaling.
- Le serveur ferme proprement le pool PostgreSQL lors d'un arrêt.

## Ce qui n'est PAS encore basculé

Les données métier (`users`, paiements, messages, pronostics, paramètres, etc.) restent dans SQLite. Il ne faut donc **pas multiplier les instances Render** avant la migration de ces données.

## Préparer PostgreSQL sur Render

1. Créer un Render Postgres dans la même région que le service web.
2. Ajouter `DATABASE_URL` avec l'URL **interne** PostgreSQL dans le service BatBot.
3. Pour un test externe uniquement, utiliser une URL externe avec TLS ; ne jamais mettre les identifiants en clair dans GitHub.
4. Définir `DATABASE_POOL_SIZE` à une valeur prudente (10 par instance au départ).
5. Définir `SESSION_SECRET` sur une valeur forte et stable.

Render recommande les connexions internes pour les services de la même région et propose PgBouncer pour gérer les volumes importants de connexions. Voir la documentation Render.

## Migration des données

Une fois PostgreSQL créé et vérifié, lancer depuis un environnement sécurisé contenant une copie de `sdrive.db` :

```bash
DATABASE_URL="..." node scripts/migrate-sqlite-to-postgres.js
```

Le script :

- crée le schéma PostgreSQL ;
- copie les données table par table ;
- conserve les identifiants existants ;
- ne supprime pas `sdrive.db` ;
- utilise une transaction PostgreSQL ;
- peut être relancé sans dupliquer les lignes grâce à `ON CONFLICT`.

## Étape suivante

Après validation de cette phase, la prochaine étape est de migrer progressivement les requêtes métier de `server.js` vers PostgreSQL. Le basculement global ne doit intervenir qu'après tests de comptes, paiements, messages, pronostics, administration et analyses.
> **Important :** tant que les données métier restent dans SQLite, `DATABASE_URL` ne doit pas être considérée comme un basculement complet de la base de données. Cette phase active uniquement le stockage PostgreSQL des sessions.


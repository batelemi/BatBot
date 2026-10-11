BATBOT — CORRECTIF CIBLÉ DES PRONOSTICS COMMUNAUTAIRES

Fichiers applicatifs à intégrer dans le dépôt en conservant les chemins:
- server.js
- public/index.html
- database/postgres-schema.sql

Migration séparée pour la base PostgreSQL déjà existante:
- database/migrations/20261011_add_betclic_url.sql

ORDRE IMPORTANT
1. Sauvegarder la base PostgreSQL Render et vérifier que la sauvegarde est disponible.
2. Exécuter le contenu SQL de database/migrations/20261011_add_betclic_url.sql sur la base BATBOT existante AVANT de déployer server.js.
3. Intégrer les trois fichiers applicatifs et le fichier de migration au dépôt GitHub.
4. Vérifier le déploiement Render et tester les publications communautaires.

Le serveur ne lance PAS la migration automatiquement au démarrage. Cela évite une modification silencieuse du schéma. Si la migration SQL n'a pas été appliquée avant le déploiement, les requêtes de publication qui lisent betclic_url échoueront jusqu'à l'ajout de la colonne.

La migration n'efface ni ne remplace aucune donnée. Le fichier postgres-schema.sql inclut également betclic_url pour les nouvelles installations.

Périmètre: formulaire et API des pronostics communautaires. Aucun changement intentionnel au moteur IA Premium, aux paiements ou au parcours manuel WhatsApp/Telegram.

Les contrôles statiques ne remplacent pas un test de bout en bout sur Render avec la base réelle.

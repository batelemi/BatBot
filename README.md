# S-Drive — dépôt prêt pour Render

## Structure finale

```text
S-Drive/
├── server.js
├── package.json
├── render.yaml
├── .env.example
├── .gitignore
└── public/
    ├── index.html
    ├── manifest.json
    ├── sw.js
    ├── icon-192.png
    └── icon-512.png
```

## Comptes clients

Les clients utilisent uniquement :
- nom d'utilisateur
- mot de passe

Aucun numéro de téléphone n'est demandé au client.

## Administration

L'administration utilise :
- ADMIN_PHONE
- ADMIN_PASSWORD

Ces deux valeurs doivent être configurées dans Render et ne sont pas écrites dans le code.

## Données

SQLite est utilisé pour les comptes, demandes, matchs et paramètres.
Pour conserver les données après redémarrage/redéploiement, le dossier DATA_DIR doit être placé sur un stockage persistant Render monté sur `/var/data`.

## Lancement local

```bash
npm install
npm start
```

Test syntaxique :

```bash
npm run check
```

## Déploiement Render

1. Créer un dépôt Git avec uniquement le contenu de `FINAL_REPOSITORY`.
2. Connecter le dépôt à Render.
3. Utiliser `npm install` pour le build et `npm start` pour le lancement.
4. Ajouter les variables d'environnement de `.env.example`.
5. Configurer un disque persistant et utiliser `/var/data` comme DATA_DIR.
6. Vérifier `/api/health`.

## Important

Ne jamais envoyer `.env`, les mots de passe, les bases SQLite ou `node_modules` dans GitHub.

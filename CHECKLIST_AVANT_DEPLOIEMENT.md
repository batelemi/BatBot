# CHECKLIST AVANT DEPLOIEMENT

01_SERVER_CORRIGE/server.js
- Client = username + password
- Admin = ADMIN_PHONE + ADMIN_PASSWORD
- Sessions SQLite
- API health
- API config sans secrets admin
- demandes Football/Loto
- Premium
- administration
- réinitialisation par username

02_INTERFACE_CORRIGEE/index.html
- aucun téléphone demandé au client
- afficher/masquer mot de passe
- profil sans téléphone
- administration
- PWA
- service worker enregistré

03_PACKAGE_DEPLOIEMENT/package.json
- Node 22.x
- npm start
- npm run check
- dépendances uniquement utiles

04_PWA_CORRIGEE/manifest.json
- scope /
- icônes 192 et 512

05_SERVICE_WORKER_CORRIGE/sw.js
- cache versionné v2
- mise à jour des anciens caches
- stratégie réseau puis cache

06_CONFIGURATION_RENDER
- .env.example
- render.yaml
- DATA_DIR=/var/data

07_DOCUMENTATION
- README de déploiement

08_ASSETS_CORRIGES
- icon-192.png
- icon-512.png

FINAL_REPOSITORY
- seule version à envoyer sur GitHub/Render

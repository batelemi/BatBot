S-DRIVE — PACKAGE DE DEPLOIEMENT FINAL

Racine du dépôt GitHub :
- server.js
- package.json
- render.yaml
- public/

Dans public/ :
- index.html
- logo.png
- icon-192.png
- icon-512.png
- manifest.json
- sw.js

IMPORTANT
1. Remplacer les fichiers correspondants dans le dépôt existant.
2. Ne pas créer un nouveau dossier public/public.
3. Ne pas supprimer package.json.
4. Commit directement sur la branche main.
5. Render est configuré pour redéployer automatiquement sur un nouveau commit.
6. Si besoin, utiliser "Clear build cache & deploy" après le commit.

CLIENTS
- Inscription : nom d'utilisateur + mot de passe + confirmation.
- Connexion : nom d'utilisateur + mot de passe.
- Aucun numéro de téléphone client.
- Mot de passe oublié : demande traitée par l'administrateur.

ADMIN
- Connexion séparée par identifiant administrateur + mot de passe.
- Gestion des utilisateurs.
- Date/heure d'inscription.
- Activation/désactivation Premium 7 jours.
- Suppression d'utilisateur.
- Réinitialisation de mot de passe avec mot de passe temporaire.
- Gestion des probabilités du jour.

LOGO
Le vrai logo S-Drive est fourni sous public/logo.png et utilisé par l'écran de chargement et l'interface.

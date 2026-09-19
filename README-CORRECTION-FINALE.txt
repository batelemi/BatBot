SMARTDRIVE / BATBOT — CORRECTION FINALE

Fichiers inclus :
- server.js
- public/index.html

Nouveautés intégrées :
- Ajout de BatBot IA côté client.
- Utilisation de l'API OpenAI en arrière-plan via OPENAI_API_KEY.
- Nom du fournisseur IA non affiché dans l'interface client.
- Statuts Premium et IA sous forme de cartes visuelles.
- Accès administrateur discret avec 10 appuis sur le symbole •.
- Organisation des options administrateur en boutons ouvrant des fenêtres.
- Correction de la fonction loadConfig manquante.
- Message de modération à la fin de la réponse IA.
- Conservation des routes et fonctions existantes présentes dans cette base.

Variables Render à prévoir :
- OPENAI_API_KEY : clé secrète OpenAI, à ne jamais placer dans index.html.
- OPENAI_MODEL : facultatif ; valeur par défaut utilisée par le serveur : gpt-4o-mini.

Important :
- Remplacer server.js à la racine du dépôt.
- Remplacer public/index.html dans le dossier public.
- Conserver le package.json déjà présent dans le dépôt.
- Vérifier les logs Render après déploiement.

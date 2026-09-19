# S-Drive — correction IA et abonnements

## Fichiers
- `server.js` : serveur à placer à la racine du projet, au même niveau que `package.json`.
- `public/index.html` : interface à placer dans le dossier `public`.

## Corrections incluses
- Un nouvel utilisateur est créé avec Premium et IA désactivés.
- Le pack administrateur Premium + IA active les deux accès pour la même durée.
- Le retrait du pack Premium + IA désactive les deux accès.
- Les badges Premium et IA sont affichés ensemble, de manière alignée.
- Le prompt IA demande une réponse courte et structurée : favori, probabilités, options, cotes indicatives et niveau de risque.
- Modèle Gemini par défaut : `gemini-3.8-flash`.
- Le modèle peut être changé avec la variable `GEMINI_MODEL`.

## Variables Render
- `GEMINI_API_KEY` : clé Google Gemini.
- `GEMINI_MODEL` : facultatif, par exemple `gemini-3.8-flash`.
- Conserver les autres variables déjà présentes dans Render.

Ne partagez jamais une clé API dans GitHub ou dans une conversation publique.


## Cette version
- Analyse structurée en JSON : probabilités, options, cotes indicatives et combinés.
- Ajout facultatif d’un deuxième match dans l’interface.
- Affichage professionnel des résultats IA.
- Un modèle Gemini 2.5 configuré par erreur est automatiquement remplacé par `gemini-3.8-flash`.
- Les nouveaux comptes sont créés avec Premium et IA désactivés.

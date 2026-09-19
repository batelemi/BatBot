# S-Drive — Correction IA v6

## Fichiers à remplacer dans GitHub
- `server.js` à la racine
- `public/index.html` dans le dossier `public`

## Corrections incluses
- À l'inscription, Premium et IA sont explicitement inactifs.
- L'activation Premium par l'administrateur active ensemble Premium + IA.
- La désactivation Premium désactive également le pack Premium + IA.
- L'IA demande une réponse structurée et l'interface transforme le JSON en cartes professionnelles : probabilités, options, cotes et combiné.
- Limite JSON augmentée pour les captures d'écran.

## Variables Render
- `GEMINI_API_KEY` : clé Gemini valide.
- `LLAMA_API_KEY` : facultatif, utilisé en secours.
- `SESSION_SECRET` : valeur longue et privée.

## Validation
1. Déployer les deux fichiers.
2. Créer un nouveau compte de test : Premium = Non actif et IA = Non actif.
3. Depuis l'administration, activer Premium + IA pour 7 jours.
4. Tester une analyse IA et vérifier l'affichage en cartes, pas en JSON brut.
5. Désactiver Premium et vérifier que les deux accès deviennent inactifs.

## Organisation de l'interface
- Un espace unique « Accès rapide » regroupe les boutons Paiements, Agents et Analyse IA.
- Un seul espace d'analyse est affiché à la fois afin d'éviter les répétitions.
- Le bouton Paiements ouvre les dépôts et abonnements.
- Le bouton Agents ouvre la demande d'analyse journalière.
- Le bouton Analyse IA ouvre l'analyse IA Premium.

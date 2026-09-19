# S-Drive IA — Version 4

Améliorations incluses :
- Badge visible « 🤖 IA activée » sur le profil lorsque l'administrateur active l'accès IA.
- Profil client plus chaleureux avec badges Premium/IA et résumé des statuts.
- Conservation de l'accès IA existant et de la gestion administrateur.
- L'utilisateur voit uniquement le nom « S-Drive IA », sans exposer les moteurs techniques.

Configuration Render :
- `GEMINI_API_KEY` : clé du moteur principal.
- `LLAMA_API_KEY` : clé du moteur de secours, si configurée dans le serveur.

Conserver le `package.json` et les autres fichiers déjà présents dans le dépôt GitHub. Tester d'abord sur la branche de travail avant de fusionner dans la branche principale.

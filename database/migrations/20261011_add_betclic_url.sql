-- BATBOT: ajout non destructif du lien de partage Betclic aux pronostics communautaires.
-- À exécuter une seule fois avant de déployer la version de server.js qui lit betclic_url.
-- ADD COLUMN IF NOT EXISTS rend le script répétable et ne supprime aucune donnée.
ALTER TABLE member_predictions
  ADD COLUMN IF NOT EXISTS betclic_url TEXT NOT NULL DEFAULT '';

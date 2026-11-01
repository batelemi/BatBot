'use strict';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const memoryCache = new Map();
const inFlight = new Map();

function createTeamHistoryCache({
  pool,
  fetchHistory,
  ttlMs = DEFAULT_TTL_MS
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('Une connexion PostgreSQL valide est obligatoire.');
  }

  if (typeof fetchHistory !== 'function') {
    throw new Error('La fonction fetchHistory est obligatoire.');
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sportapi_team_history_cache (
        team_id TEXT PRIMARY KEY,
        matches JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    console.log('BATBOT : cache PostgreSQL des historiques SportAPI prêt.');
  }

  async function getTeamHistory(teamId, apiKey) {
    const id = String(teamId || '').trim();

    if (!id) {
      throw new Error('Identifiant SportAPI de l’équipe manquant.');
    }

    const cached = memoryCache.get(id);

    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.matches;
    }

    if (inFlight.has(id)) {
      return inFlight.get(id);
    }

    const operation = loadTeamHistory(id, apiKey);
    inFlight.set(id, operation);

    try {
      return await operation;
    } finally {
      if (inFlight.get(id) === operation) {
        inFlight.delete(id);
      }
    }
  }

  async function loadTeamHistory(id, apiKey) {
    const client = await pool.connect();
    const lockKey = `batbot:sportapi:team-history:${id}`;
    let lockAcquired = false;
    let staleMatches = null;

    try {
      await client.query(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [lockKey]
      );
      lockAcquired = true;

      const result = await client.query(
        `SELECT matches, fetched_at
         FROM sportapi_team_history_cache
         WHERE team_id = $1`,
        [id]
      );

      const row = result.rows[0] || null;

      if (row) {
        staleMatches = row.matches;

        const fetchedAt = new Date(row.fetched_at).getTime();

        if (
          Number.isFinite(fetchedAt) &&
          Date.now() - fetchedAt < ttlMs
        ) {
          memoryCache.set(id, {
            matches: row.matches,
            fetchedAt
          });

          return row.matches;
        }
      }

      try {
        const matches = await fetchHistory(id, apiKey);

        if (!Array.isArray(matches)) {
          throw new Error(
            `Historique SportAPI invalide pour l’équipe ${id}.`
          );
        }

        await client.query(
          `INSERT INTO sportapi_team_history_cache
             (team_id, matches, fetched_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (team_id)
           DO UPDATE SET
             matches = EXCLUDED.matches,
             fetched_at = NOW()`,
          [id, JSON.stringify(matches)]
        );

        memoryCache.set(id, {
          matches,
          fetchedAt: Date.now()
        });

        return matches;
      } catch (error) {
        if (Array.isArray(staleMatches)) {
          console.warn(
            `BATBOT : ancien historique conservé pour l’équipe ${id} :`,
            error.message
          );

          memoryCache.set(id, {
            matches: staleMatches,
            fetchedAt: 0
          });

          return staleMatches;
        }

        throw error;
      }
    } finally {
      try {
        if (lockAcquired) {
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [lockKey]
          );
        }
      } finally {
        client.release();
      }
    }
  }

  function clearMemoryCache() {
    memoryCache.clear();
  }

  return {
    initialize,
    getTeamHistory,
    clearMemoryCache
  };
}

module.exports = {
  createTeamHistoryCache,
  DEFAULT_TTL_MS
};

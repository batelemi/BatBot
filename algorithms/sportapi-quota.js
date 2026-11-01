'use strict';

let databasePool = null;

const DEFAULT_DAILY_LIMIT = 2000;

function getDailyLimit() {
  const configured = Number(process.env.SPORTAPI_DAILY_LIMIT || DEFAULT_DAILY_LIMIT);

  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new Error('SPORTAPI_DAILY_LIMIT doit être un entier positif.');
  }

  return configured;
}

async function initializeSportApiQuota(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Connexion PostgreSQL invalide pour le quota SportAPI.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sportapi_daily_usage (
      usage_date DATE PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  databasePool = pool;

  console.log(
    `BATBOT : compteur journalier SportAPI prêt (plafond : ${getDailyLimit()}).`
  );
}

async function reserveSportApiCall(label = 'requête') {
  if (!databasePool) {
    throw new Error('Compteur SportAPI non initialisé.');
  }

  const limit = getDailyLimit();
  const utcDate = new Date().toISOString().slice(0, 10);

  const result = await databasePool.query(
    `INSERT INTO sportapi_daily_usage (usage_date, request_count)
     VALUES ($1::date, 1)
     ON CONFLICT (usage_date)
     DO UPDATE SET
       request_count = sportapi_daily_usage.request_count + 1,
       updated_at = NOW()
     WHERE sportapi_daily_usage.request_count < $2
     RETURNING request_count`,
    [utcDate, limit]
  );

  if (!result.rows || result.rows.length === 0) {
    const error = new Error(
      `Plafond journalier SportAPI atteint (${limit} appels).`
    );
    error.code = 'SPORTAPI_DAILY_LIMIT';
    error.status = 429;
    throw error;
  }

  return {
    date: utcDate,
    count: result.rows[0].request_count,
    limit,
    label
  };
}

module.exports = {
  initializeSportApiQuota,
  reserveSportApiCall,
  DEFAULT_DAILY_LIMIT
};

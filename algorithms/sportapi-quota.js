'use strict';

let databasePool = null;

const DEFAULT_DAILY_LIMIT = 2000;
const FREE_PLAN_CHANGE_DATE = '2026-12-01';

function readLimit(name, fallback, allowZero = false) {
  const raw = process.env[name];

  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }

  const configured = Number(raw);

  if (
    !Number.isSafeInteger(configured) ||
    (allowZero ? configured < 0 : configured < 1)
  ) {
    throw new Error(`${name} doit être un entier ${allowZero ? 'positif ou nul' : 'positif'}.`);
  }

  return configured;
}

function getQuotaConfig(now = new Date()) {
  const plan = String(process.env.SPORTAPI_PLAN || 'free')
    .trim()
    .toLowerCase();

  if (plan !== 'free' && plan !== 'starter') {
    throw new Error('SPORTAPI_PLAN doit être égal à free ou starter.');
  }

  if (plan === 'starter') {
    return {
      plan,
      dailyLimit: readLimit('SPORTAPI_STARTER_DAILY_LIMIT', 9000),
      monthlyLimit: readLimit('SPORTAPI_STARTER_MONTHLY_LIMIT', 0, true)
    };
  }

  const date = now.toISOString().slice(0, 10);
  const newFreeLimitsActive = date >= FREE_PLAN_CHANGE_DATE;

  let dailyFallback = newFreeLimitsActive ? 900 : 1900;

  // Compatibilité avec l'ancienne variable jusqu'au changement d'offre.
  if (!newFreeLimitsActive) {
    dailyFallback = readLimit('SPORTAPI_DAILY_LIMIT', dailyFallback);
  }

  return {
    plan,
    dailyLimit: readLimit('SPORTAPI_FREE_DAILY_LIMIT', dailyFallback),
    monthlyLimit: readLimit(
      'SPORTAPI_FREE_MONTHLY_LIMIT',
      newFreeLimitsActive ? 6500 : 13000,
      true
    )
  };
}

function createQuotaError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 429;
  return error;
}

async function initializeSportApiQuota(pool) {
  if (
    !pool ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function'
  ) {
    throw new Error('Connexion PostgreSQL invalide pour le quota SportAPI.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sportapi_daily_usage (
      usage_date DATE PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sportapi_monthly_usage (
      usage_month DATE PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  databasePool = pool;

  const config = getQuotaConfig();

  console.log(
    `BATBOT : compteur SportAPI prêt (formule : ${config.plan}, ` +
    `plafond journalier : ${config.dailyLimit}, ` +
    `plafond mensuel : ${config.monthlyLimit === 0 ? 'désactivé' : config.monthlyLimit}).`
  );
}

async function reserveSportApiCall(label = 'requête') {
  if (!databasePool) {
    throw new Error('Compteur SportAPI non initialisé.');
  }

  const config = getQuotaConfig();
  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10);
  const utcMonth = `${utcDate.slice(0, 7)}-01`;

  const client = await databasePool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    const dailyResult = await client.query(
      `INSERT INTO sportapi_daily_usage (usage_date, request_count)
       VALUES ($1::date, 1)
       ON CONFLICT (usage_date)
       DO UPDATE SET
         request_count = sportapi_daily_usage.request_count + 1,
         updated_at = NOW()
       WHERE sportapi_daily_usage.request_count < $2
       RETURNING request_count`,
      [utcDate, config.dailyLimit]
    );

    if (!dailyResult.rows || dailyResult.rows.length === 0) {
      throw createQuotaError(
        'SPORTAPI_DAILY_LIMIT',
        `Plafond journalier SportAPI atteint (${config.dailyLimit} appels).`
      );
    }

    let monthlyCount = null;

    if (config.monthlyLimit > 0) {
      const monthlyResult = await client.query(
        `INSERT INTO sportapi_monthly_usage (usage_month, request_count)
         VALUES ($1::date, 1)
         ON CONFLICT (usage_month)
         DO UPDATE SET
           request_count = sportapi_monthly_usage.request_count + 1,
           updated_at = NOW()
         WHERE sportapi_monthly_usage.request_count < $2
         RETURNING request_count`,
        [utcMonth, config.monthlyLimit]
      );

      if (!monthlyResult.rows || monthlyResult.rows.length === 0) {
        throw createQuotaError(
          'SPORTAPI_MONTHLY_LIMIT',
          `Plafond mensuel SportAPI atteint (${config.monthlyLimit} appels).`
        );
      }

      monthlyCount = monthlyResult.rows[0].request_count;
    }

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      date: utcDate,
      count: dailyResult.rows[0].request_count,
      limit: config.dailyLimit,
      monthlyDate: utcMonth,
      monthlyCount,
      monthlyLimit: config.monthlyLimit,
      plan: config.plan,
      label
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('SPORTAPI QUOTA ROLLBACK:', rollbackError.message);
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  initializeSportApiQuota,
  reserveSportApiCall,
  DEFAULT_DAILY_LIMIT
};

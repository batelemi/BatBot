'use strict';

const assert = require('node:assert/strict');

process.env.SPORTAPI_PLAN = 'free';
process.env.SPORTAPI_FREE_DAILY_LIMIT = '3';
process.env.SPORTAPI_FREE_MONTHLY_LIMIT = '4';

const {
  initializeSportApiQuota,
  reserveSportApiCall
} = require('./sportapi-quota');

const dailyUsage = new Map();
const monthlyUsage = new Map();

const fakePool = {
  async query(sql) {
    if (sql.includes('CREATE TABLE')) return { rows: [] };
    throw new Error(`Requête inattendue sur le pool : ${sql}`);
  },

  async connect() {
    let dailySnapshot = null;
    let monthlySnapshot = null;

    return {
      async query(sql, params = []) {
        if (sql === 'BEGIN') {
          dailySnapshot = new Map(dailyUsage);
          monthlySnapshot = new Map(monthlyUsage);
          return { rows: [] };
        }

        if (sql === 'COMMIT') {
          dailySnapshot = null;
          monthlySnapshot = null;
          return { rows: [] };
        }

        if (sql === 'ROLLBACK') {
          dailyUsage.clear();
          monthlyUsage.clear();

          for (const [key, value] of dailySnapshot || []) {
            dailyUsage.set(key, value);
          }

          for (const [key, value] of monthlySnapshot || []) {
            monthlyUsage.set(key, value);
          }

          return { rows: [] };
        }

        const isDaily = sql.includes('INSERT INTO sportapi_daily_usage');
        const isMonthly = sql.includes('INSERT INTO sportapi_monthly_usage');

        if (!isDaily && !isMonthly) {
          throw new Error(`Requête transactionnelle inattendue : ${sql}`);
        }

        const usage = isDaily ? dailyUsage : monthlyUsage;
        const [date, limit] = params;
        const count = usage.get(date) || 0;

        if (count >= limit) return { rows: [] };

        usage.set(date, count + 1);
        return { rows: [{ request_count: count + 1 }] };
      },

      release() {}
    };
  }
};

(async () => {
  await initializeSportApiQuota(fakePool);

  const first = await reserveSportApiCall('test 1');
  const second = await reserveSportApiCall('test 2');
  const third = await reserveSportApiCall('test 3');

  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(third.count, 3);

  await assert.rejects(
    reserveSportApiCall('test 4'),
    error => error.code === 'SPORTAPI_DAILY_LIMIT' && error.status === 429
  );

  assert.equal(dailyUsage.get(first.date), 3);
  assert.equal(monthlyUsage.get(first.monthlyDate), 3);

  console.log('OK : plafond quotidien respecté.');

  process.env.SPORTAPI_FREE_DAILY_LIMIT = '10';
  process.env.SPORTAPI_FREE_MONTHLY_LIMIT = '3';

  await assert.rejects(
    reserveSportApiCall('test mensuel'),
    error => error.code === 'SPORTAPI_MONTHLY_LIMIT' && error.status === 429
  );

  assert.equal(dailyUsage.get(first.date), 3);
  assert.equal(monthlyUsage.get(first.monthlyDate), 3);

  console.log('OK : plafond mensuel respecté.');
  console.log('OK : rollback du compteur journalier si le plafond mensuel est atteint.');

  process.env.SPORTAPI_FREE_MONTHLY_LIMIT = '0';

  const withoutMonthlyLimit = await reserveSportApiCall('test sans plafond mensuel');

  assert.equal(withoutMonthlyLimit.count, 4);
  assert.equal(withoutMonthlyLimit.monthlyCount, null);
  assert.equal(monthlyUsage.get(first.monthlyDate), 3);

  console.log('OK : désactivation du plafond mensuel.');

  process.env.SPORTAPI_PLAN = 'starter';
  process.env.SPORTAPI_STARTER_DAILY_LIMIT = '6';
  process.env.SPORTAPI_STARTER_MONTHLY_LIMIT = '0';

  const starterFirst = await reserveSportApiCall('starter 1');
  const starterSecond = await reserveSportApiCall('starter 2');

  assert.equal(starterFirst.plan, 'starter');
  assert.equal(starterFirst.limit, 6);
  assert.equal(starterFirst.count, 5);
  assert.equal(starterSecond.count, 6);

  await assert.rejects(
    reserveSportApiCall('starter 3'),
    error => error.code === 'SPORTAPI_DAILY_LIMIT' && error.status === 429
  );

  console.log('OK : sélection de la formule Starter et de ses limites.');
  console.log('TOUS LES TESTS DU COMPTEUR SPORTAPI SONT RÉUSSIS.');
})().catch(error => {
  console.error('TEST QUOTA ÉCHOUÉ :', error);
  process.exitCode = 1;
});

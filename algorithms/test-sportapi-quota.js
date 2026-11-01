'use strict';

const assert = require('node:assert/strict');

process.env.SPORTAPI_DAILY_LIMIT = '3';

const {
  initializeSportApiQuota,
  reserveSportApiCall
} = require('./sportapi-quota');

const usage = new Map();

const fakePool = {
  async query(sql, params) {
    if (sql.includes('CREATE TABLE')) {
      return { rows: [] };
    }

    const [date, limit] = params;
    const count = usage.get(date) || 0;

    if (count >= limit) {
      return { rows: [] };
    }

    usage.set(date, count + 1);
    return { rows: [{ request_count: count + 1 }] };
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

  console.log('OK : les trois premières réservations sont acceptées.');
  console.log('OK : la quatrième réservation est bloquée.');
  console.log('TOUS LES TESTS DU COMPTEUR SPORTAPI SONT RÉUSSIS.');
})().catch(error => {
  console.error('TEST QUOTA ÉCHOUÉ :', error);
  process.exitCode = 1;
});

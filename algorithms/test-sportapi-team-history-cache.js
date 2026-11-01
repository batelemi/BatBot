'use strict';

const assert = require('node:assert/strict');
const {
  createTeamHistoryCache
} = require('./sportapi-team-history-cache');

function createFakePool() {
  const rows = new Map();

  return {
    rows,

    async query() {
      return { rows: [], rowCount: 0 };
    },

    async connect() {
      return {
        async query(sql, params = []) {
          if (sql.includes('pg_advisory_lock')) {
            return { rows: [{ pg_advisory_lock: true }] };
          }

          if (sql.includes('pg_advisory_unlock')) {
            return { rows: [{ pg_advisory_unlock: true }] };
          }

          if (sql.includes('SELECT matches, fetched_at')) {
            const row = rows.get(params[0]);
            return { rows: row ? [row] : [] };
          }

          if (sql.includes('INSERT INTO sportapi_team_history_cache')) {
            rows.set(params[0], {
              matches: JSON.parse(params[1]),
              fetched_at: new Date()
            });
            return { rows: [], rowCount: 1 };
          }

          throw new Error(`Requête SQL inattendue : ${sql}`);
        },

        release() {}
      };
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function main() {
  const pool = createFakePool();
  let calls = 0;

  const cache = createTeamHistoryCache({
    pool,
    fetchHistory: async id => {
      calls++;
      return [{ team_id: id, result: 'FT' }];
    }
  });

  await cache.initialize();

  const first = await cache.getTeamHistory('11', 'test-key');
  const second = await cache.getTeamHistory('11', 'test-key');

  assert.deepEqual(first, [{ team_id: '11', result: 'FT' }]);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  console.log('OK : historique réutilisé depuis la mémoire.');

  cache.clearMemoryCache();

  const secondInstance = createTeamHistoryCache({
    pool,
    fetchHistory: async () => {
      calls++;
      return [];
    }
  });

  const persisted = await secondInstance.getTeamHistory('11', 'test-key');

  assert.deepEqual(persisted, first);
  assert.equal(calls, 1);
  console.log('OK : historique réutilisé depuis PostgreSQL.');

  const gate = deferred();
  let concurrentCalls = 0;

  const concurrentCache = createTeamHistoryCache({
    pool,
    fetchHistory: async id => {
      concurrentCalls++;
      return gate.promise;
    }
  });

  const request1 = concurrentCache.getTeamHistory('22', 'test-key');
  const request2 = concurrentCache.getTeamHistory('22', 'test-key');

  await new Promise(resolve => setImmediate(resolve));
  gate.resolve([{ team_id: '22', result: 'FT' }]);

  const [result1, result2] = await Promise.all([request1, request2]);

  assert.deepEqual(result1, result2);
  assert.equal(concurrentCalls, 1);
  console.log('OK : appels simultanés regroupés en une seule récupération.');

  pool.rows.set('33', {
    matches: [{ team_id: '33', result: 'FT' }],
    fetched_at: new Date(Date.now() - 10 * 60 * 60 * 1000)
  });

  const fallbackCache = createTeamHistoryCache({
    pool,
    fetchHistory: async () => {
      throw new Error('Panne SportAPI simulée');
    }
  });

  const fallback = await fallbackCache.getTeamHistory('33', 'test-key');

  assert.deepEqual(fallback, [{ team_id: '33', result: 'FT' }]);
  console.log('OK : ancien historique conservé après une panne SportAPI.');

  console.log('\nTOUS LES TESTS DU CACHE DES HISTORIQUES SONT RÉUSSIS.');
}

main().catch(error => {
  console.error('\nÉCHEC DU TEST :', error);
  process.exitCode = 1;
});

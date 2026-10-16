'use strict';

const assert = require('node:assert/strict');
const { normalizeFixture } = require('./sportapi-fixtures-service');
const {
  analyzeSportApiMatches,
  extractHistoryMatches,
  isFinishedMatch
} = require('./sportapi-odds-service');

assert.deepEqual(extractHistoryMatches({ matches: [1] }), [1]);
assert.deepEqual(extractHistoryMatches({ results: [2] }), [2]);
assert.deepEqual(extractHistoryMatches({ data: { matches: [3] } }), [3]);
assert.deepEqual(extractHistoryMatches({ data: { results: [4] } }), [4]);
assert.deepEqual(extractHistoryMatches({ data: [5] }), [5]);
assert.equal(isFinishedMatch({ status: 'PENS' }), true);

const flat = normalizeFixture({
  id: 100,
  date: '2026-10-16T18:00:00Z',
  status: 'Scheduled',
  home_team: 'Alpha FC',
  away_team: 'Beta FC',
  home_id: 11,
  away_id: 22,
  home_logo: 'https://example.test/alpha.png',
  away_logo: 'https://example.test/beta.png'
});
assert.equal(flat.teams.home.id, '11');
assert.equal(flat.teams.away.id, '22');
assert.equal(flat.teams.home.logo, 'https://example.test/alpha.png');
assert.equal(flat.teams.away.logo, 'https://example.test/beta.png');

const nested = normalizeFixture({
  id: 101,
  date: '2026-10-16T19:00:00Z',
  status: { short: 'NS', long: 'Not started' },
  teams: {
    home: { id: 31, name: 'Gamma', logo: 'https://example.test/gamma.png' },
    away: { id: 32, name: 'Delta', logo: 'https://example.test/delta.png' }
  }
});
assert.equal(nested.teams.home.id, '31');
assert.equal(nested.teams.home.logo, 'https://example.test/gamma.png');
assert.equal(nested.teams.away.id, '32');
assert.equal(nested.teams.away.logo, 'https://example.test/delta.png');


// Contrats variantes homeTeam/home_team_data
const variants = normalizeFixture({
  id: 102,
  date: '2026-10-16T20:00:00Z',
  status: 'NS',
  homeTeam: {
    id: 41,
    name: 'espn-304.png Mansfield Town',
    logo: 'https://example.test/mansfield.png'
  },
  away_team_data: {
    id: 42,
    name: 'Oxford United',
    logo: 'https://example.test/oxford.png'
  }
});
assert.ok(variants, 'Le format homeTeam/home_team_data doit être accepté');
assert.equal(variants.teams.home.id, '41');
assert.equal(variants.teams.away.id, '42');
assert.equal(variants.teams.home.name, 'Mansfield Town');
assert.equal(variants.teams.away.name, 'Oxford United');
assert.equal(variants.teams.home.logo, 'https://example.test/mansfield.png');
assert.equal(variants.teams.away.logo, 'https://example.test/oxford.png');

const objectNames = normalizeFixture({
  id: 103,
  date: '2026-10-16T21:00:00Z',
  status: 'NS',
  home_team: { id: 51, name: 'Africa Sports', logo: 'https://example.test/africa.png' },
  away_team: { id: 52, name: 'ASEC Mimosas', logo: 'https://example.test/asec.png' }
});
assert.ok(objectNames, 'Les objets home_team/away_team doivent être acceptés');
assert.equal(objectNames.teams.home.name, 'Africa Sports');
assert.equal(objectNames.teams.away.name, 'ASEC Mimosas');
assert.equal(objectNames.teams.home.logo, 'https://example.test/africa.png');
assert.equal(objectNames.teams.away.logo, 'https://example.test/asec.png');

function historyFor(teamId) {
  return Array.from({ length: 6 }, (_, index) => {
    const isHome = index % 2 === 0;
    return {
      home_id: isHome ? teamId : 100 + index,
      away_id: isHome ? 200 + index : teamId,
      home_team: isHome ? `Team ${teamId}` : `Opponent ${index}`,
      away_team: isHome ? `Opponent ${index}` : `Team ${teamId}`,
      home_score: index % 3 === 0 ? 2 : 1,
      away_score: index % 3 === 1 ? 2 : 0,
      status: index === 5 ? 'PENS' : 'FT',
      date: `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00Z`
    };
  });
}

(async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const teamId = String(url).endsWith('/teams/11') ? 11 : 22;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, results: historyFor(teamId) })
      };
    };
    const result = await analyzeSportApiMatches([{
      fixture: { id: 'test-fixture' },
      teams: {
        home: { id: 11, name: 'Alpha', logo: 'https://example.test/alpha.png' },
        away: { id: 22, name: 'Beta', logo: 'https://example.test/beta.png' }
      }
    }], { apiKey: 'test-key' });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].homeTeam.logo, 'https://example.test/alpha.png');
    assert.equal(result.matches[0].awayTeam.logo, 'https://example.test/beta.png');
    assert.equal(result.matches[0].stats.home.matches, 6);
    assert.equal(result.matches[0].stats.away.matches, 6);
    console.log('TEST CONTRATS SPORTAPI.AI : OK');
    console.log('Historique formats matches/results/data : OK');
    console.log('Statut PENS, IDs et logos jusqu’au résultat d’analyse : OK');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error('TEST CONTRATS SPORTAPI.AI : ÉCHEC', error);
  process.exitCode = 1;
});

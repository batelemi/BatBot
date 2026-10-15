'use strict';

const assert = require('node:assert/strict');
const { collectTeamStats, isFinishedMatch } = require('./sportapi-odds-service');
const { calculateOdds } = require('./odds-engine');

const teamHistory = [
  { home_id: 10, away_id: 20, home_team: 'Alpha FC', away_team: 'Beta FC', home_score: 2, away_score: 0, status: 'FT', date: '2026-10-01T12:00:00Z' },
  { home_id: 30, away_id: 10, home_team: 'Gamma', away_team: 'Alpha FC', home_score: 1, away_score: 1, status: 'FT', date: '2026-10-02T12:00:00Z' },
  { home_id: 10, away_id: 40, home_team: 'Alpha FC', away_team: 'Delta', home_score: 1, away_score: 0, status: 'FT', date: '2026-10-03T12:00:00Z' },
  { home_id: 50, away_id: 10, home_team: 'Epsilon', away_team: 'Alpha FC', home_score: 0, away_score: 2, status: 'FT', date: '2026-10-04T12:00:00Z' },
  { home_id: 10, away_id: 60, home_team: 'Alpha FC', away_team: 'Zeta', home_score: 3, away_score: 1, status: 'FT', date: '2026-10-05T12:00:00Z' },
  { home_id: 70, away_id: 10, home_team: 'Eta', away_team: 'Alpha FC', home_score: 1, away_score: 0, status: 'FT', date: '2026-10-06T12:00:00Z' },
  { home_id: 10, away_id: 80, home_team: 'Alpha FC', away_team: 'Theta', home_score: 2, away_score: 2, status: 'NS', date: '2026-10-07T12:00:00Z' }
];

assert.equal(isFinishedMatch(teamHistory[0]), true);
assert.equal(isFinishedMatch(teamHistory[6]), false);
const stats = collectTeamStats(teamHistory, '10', 'Alpha FC');
assert.equal(stats.matches, 6, 'Seuls les matchs terminés avec scores doivent être comptés.');
assert.equal(stats.homeMatches, 3);
assert.equal(stats.awayMatches, 3);
assert.equal(stats.goalsFor, 9);
assert.equal(stats.goalsAgainst, 3);

const result = calculateOdds({ home: stats, away: { ...stats, matches: 6, homeMatches: 3, awayMatches: 3 } });
assert.equal(result.sufficientData, true);
const sum = result.oneXTwo.home.probability + result.oneXTwo.draw.probability + result.oneXTwo.away.probability;
assert.ok(Math.abs(sum - 100) < 0.05, 'Les probabilités 1X2 doivent totaliser environ 100 %.');
assert.ok(result.mostLikelyScore.score.includes('-'));

console.log('TEST SPORTAPI.AI / POISSON V3 : OK');
console.log('Historique terminé, identifiants réels et calcul 1X2 : OK');
console.log('Aucun appel réseau et aucune modification PostgreSQL.');

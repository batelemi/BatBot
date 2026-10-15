'use strict';

const assert = require('node:assert/strict');
const { normalizeFixture, mergeFootballFixtures } = require('./football-fixtures-merge-service');

const kickoff = '2026-10-16T18:00:00Z';
const sportApi = [
  { id: 901, home_team: 'Paris FC', away_team: 'Lyon', kickoff_utc: kickoff, status: 'Scheduled' },
  { id: 902, home_team: 'Marseille', away_team: 'Nice', kickoff_utc: kickoff, status: 'Scheduled' },
  { id: 903, home_team: 'Équipe inconnue', away_team: 'Visiteur', kickoff_utc: kickoff, status: 'Mystery' },
  { id: 904, home_team: 'Équipe reportée', away_team: 'Visiteur', kickoff_utc: kickoff, status: 'Postponed' }
];

const fixtures = mergeFootballFixtures(sportApi);
assert.equal(fixtures.length, 4);
assert.ok(fixtures.every(item => item.fixtureSource === 'SportAPI.ai'));
assert.equal(fixtures.find(item => item.teams.home.name === 'Paris FC').fixture.id, '901');
assert.equal(fixtures.find(item => item.teams.home.name === 'Équipe inconnue')?.fixture.status.short, 'UNKNOWN');
assert.equal(fixtures.find(item => item.teams.home.name === 'Équipe inconnue')?.eligibility.canAnalyze, false);
assert.equal(fixtures.find(item => item.teams.home.name === 'Équipe reportée')?.fixture.status.short, 'CANCELLED');
assert.equal(fixtures.find(item => item.teams.home.name === 'Équipe reportée')?.eligibility.canAnalyze, false);

const fromTime = normalizeFixture({ id: 'time-1', home: 'Test domicile', away: 'Test extérieur', time: kickoff, status: 'upcoming' }, 'SportAPI.ai');
assert.ok(fromTime);
assert.equal(fromTime.fixture.date, kickoff);

console.log('TEST SPORTAPI.AI UNIQUEMENT : OK');
console.log(`Matchs normalisés : ${fixtures.length}`);
console.log('Statuts, dates et blocage des matchs non analysables : OK');
console.log('Aucune fusion multi-source ni requête réseau.');

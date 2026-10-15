'use strict';

const assert = require('node:assert/strict');
const {
  normalizeFixture,
  sameFixture,
  mergeFootballFixtures
} = require('./football-fixtures-merge-service');

const kickoff = '2026-10-16T18:00:00Z';

const sportApi = [
  {
    id: 901,
    home_team: 'Paris FC',
    away_team: 'Lyon',
    kickoff_utc: kickoff,
    status: 'Scheduled'
  },
  {
    id: 902,
    home_team: 'Marseille',
    away_team: 'Nice',
    kickoff_utc: kickoff,
    status: 'Scheduled'
  },
  {
    id: 903,
    home_team: 'Équipe inconnue',
    away_team: 'Visiteur',
    kickoff_utc: kickoff,
    status: 'Mystery'
  },
  {
    id: 904,
    home_team: 'Équipe reportée',
    away_team: 'Visiteur',
    kickoff_utc: kickoff,
    status: 'Postponed'
  }
];

const sportScore = [
  {
    id: 'ss-1',
    home: 'Paris FC',
    away: 'Lyon',
    time: kickoff,
    status: 'upcoming'
  },
  {
    id: 'ss-2',
    home: 'Bordeaux',
    away: 'Nantes',
    time: kickoff,
    status: 'upcoming'
  },
  {
    id: 'ss-3',
    home: 'Équipe terminée',
    away: 'Visiteur',
    time: kickoff,
    status: 'finished'
  }
];

const merged = mergeFootballFixtures(sportScore, sportApi);

assert.equal(
  merged.filter(f => f.teams.home.name === 'Paris FC').length,
  1,
  'Le doublon doit être supprimé.'
);

const paris = merged.find(f => f.teams.home.name === 'Paris FC');
assert.equal(paris.fixtureSource, 'SportAPI.ai');
assert.equal(paris.fixture.id, '901');

assert.ok(
  merged.some(f => f.teams.home.name === 'Bordeaux'),
  'Le match complémentaire SportScore doit être conservé.'
);

const unknown = merged.find(f => f.teams.home.name === 'Équipe inconnue');
assert.equal(unknown?.fixture.status.short, 'UNKNOWN');
assert.equal(unknown?.eligibility.canAnalyze, false);

const postponed = merged.find(f => f.teams.home.name === 'Équipe reportée');
assert.equal(postponed?.fixture.status.short, 'CANCELLED');
assert.equal(postponed?.eligibility.canAnalyze, false);

const finished = merged.find(f => f.teams.home.name === 'Équipe terminée');
assert.equal(finished?.fixture.status.short, 'FT');
assert.equal(finished?.eligibility.canAnalyze, false);

const fromTime = normalizeFixture({
  id: 'time-1',
  home: 'Test domicile',
  away: 'Test extérieur',
  time: kickoff,
  status: 'upcoming'
}, 'SportScore');

assert.ok(fromTime, 'Le champ time doit permettre de reconnaître la date.');
assert.equal(fromTime.fixture.date, kickoff);

const later = normalizeFixture({
  id: 'later',
  home: 'Paris FC',
  away: 'Lyon',
  time: '2026-10-16T21:00:00Z',
  status: 'upcoming'
}, 'SportScore');

assert.equal(sameFixture(paris, later), false);

console.log('TEST DU MODULE RÉEL : OK');
console.log(`Matchs fusionnés : ${merged.length}`);
console.log('Priorité SportAPI.ai, doublons, dates et statuts : OK');
console.log('Aucun appel réseau et aucune modification PostgreSQL.');

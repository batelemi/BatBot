'use strict';

const assert = require('node:assert/strict');

const visuals = require('./football-visuals-service');

assert.equal(
  visuals.normalizeName(' Atlético  de Madrid '),
  'atletico de madrid'
);

assert.equal(
  visuals.normalizeName('Paris Saint-Germain'),
  'paris saint germain'
);

assert.equal(
  visuals.isValidImageUrl('https://crests.football-data.org/86.png'),
  true
);

assert.equal(
  visuals.isValidImageUrl('http://crests.football-data.org/86.png'),
  false
);

assert.equal(
  visuals.isValidImageUrl('https://example.com/logo.png'),
  false
);

assert.equal(
  visuals.isValidImageUrl('javascript:alert(1)'),
  false
);

const teams = [
  { id: 1, name: 'Real Madrid CF', crest: 'https://crests.football-data.org/86.png' },
  { id: 2, name: 'FC Barcelona', crest: null }
];

assert.equal(
  visuals.findExactMatch(teams, 'real madrid cf', team => team.name).id,
  1
);

assert.equal(
  visuals.findExactMatch(teams, 'Real Madrid', team => team.name),
  null
);

assert.equal(
  visuals.normalizeTeamVisual(teams[0]).logo,
  'https://crests.football-data.org/86.png'
);

assert.equal(
  visuals.normalizeTeamVisual(teams[1]).logo,
  null
);

assert.equal(
  visuals.normalizeCompetitionVisual({
    id: 2021,
    name: 'Premier League',
    code: 'PL',
    emblem: 'https://crests.football-data.org/PL.png'
  }).logo,
  'https://crests.football-data.org/PL.png'
);

console.log('TESTS FOOTBALL VISUALS : OK');

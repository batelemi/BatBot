'use strict';

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getTeamNames(match) {
  return {
    home: normalizeName(
      match?.teams?.home?.name ||
      match?.home_team ||
      match?.home ||
      ''
    ),
    away: normalizeName(
      match?.teams?.away?.name ||
      match?.away_team ||
      match?.away ||
      ''
    )
  };
}

function getKickoff(match) {
  const value =
    match?.fixture?.date ||
    match?.kickoff_utc ||
    match?.datetime ||
    match?.date ||
    match?.time ||
    '';

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getStatus(match) {
  const value =
    match?.fixture?.status?.short ||
    match?.status?.short ||
    match?.status ||
    match?.status_code ||
    match?.state ||
    '';

  const raw = String(value).trim().toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (/\b(FT|AET|PEN|FINISHED|FULL_TIME|COMPLETED|ENDED)\b/.test(raw)) {
    return 'FT';
  }

  if (/CANCEL|POSTPON|ABANDON|SUSPEND|ANNUL|REPORT/.test(raw)) {
    return 'CANCELLED';
  }

  if (/^(LIVE|1H|2H|HT|ET|IN_PLAY|IN_PROGRESS|FIRST_HALF|SECOND_HALF|HALF_TIME|HALFTIME|EXTRA_TIME|PENALTIES|PAUSED)$/.test(raw)) {
    return 'LIVE';
  }

  if (/^(NS|SCHEDULED|NOT_STARTED|TIMED|UPCOMING|FIXTURE)$/.test(raw)) {
    return 'NS';
  }

  return 'UNKNOWN';
}

function normalizeFixture(match, source) {
  if (!match || typeof match !== 'object') return null;

  const teams = getTeamNames(match);
  const kickoff = getKickoff(match);

  if (!teams.home || !teams.away || kickoff === null) return null;

  const status = getStatus(match);
  const homeName =
    match?.teams?.home?.name || match?.home_team || match?.home || '';
  const awayName =
    match?.teams?.away?.name || match?.away_team || match?.away || '';

  const originalHomeScore =
    match?.goals?.home ?? match?.home_score ?? match?.score?.home;
  const originalAwayScore =
    match?.goals?.away ?? match?.away_score ?? match?.score?.away;

  function validScore(value) {
    return value !== null && value !== undefined &&
      value !== '' && Number.isFinite(Number(value)) &&
      Number(value) >= 0;
  }

  const hasScore =
    validScore(originalHomeScore) && validScore(originalAwayScore);

  const originalDate =
    match?.fixture?.date || match?.kickoff_utc ||
    match?.datetime || match?.date || match?.time;

  const fixtureId =
    match?.fixture?.id ?? match?.id ??
    match?.sportapi?.rawId ?? match?.sportscore?.id ?? null;

  const existingLeague = match?.league || match?.competition;
  const leagueName =
    (typeof existingLeague === 'object'
      ? existingLeague?.name
      : existingLeague) ||
    match?.league_name || 'Compétition inconnue';

  const normalized = {
    ...match,
    fixture: {
      ...(match.fixture || {}),
      id: fixtureId == null ? null : String(fixtureId),
      date: String(originalDate),
      status: {
        ...(typeof match?.fixture?.status === 'object'
          ? match.fixture.status : {}),
        short: status,
        long:
          match?.fixture?.status?.long ||
          match?.status?.long ||
          (typeof match.status === 'string' ? match.status : '') ||
          status
      }
    },
    teams: {
      ...(match.teams || {}),
      home: {
        ...(match?.teams?.home || {}),
        name: String(homeName).trim()
      },
      away: {
        ...(match?.teams?.away || {}),
        name: String(awayName).trim()
      }
    },
    league: {
      ...(typeof match.league === 'object' ? match.league : {}),
      name: String(leagueName)
    },
    goals: {
      home: hasScore ? Number(originalHomeScore) : null,
      away: hasScore ? Number(originalAwayScore) : null
    },
    eligibility: {
      finished: status === 'FT',
      cancelled: status === 'CANCELLED',
      live: status === 'LIVE',
      scheduled: status === 'NS',
      canAnalyze: status === 'NS' || status === 'LIVE'
    },
    fixtureSource: source
  };

  return normalized;
}

function sameFixture(a, b) {
  const teamsA = getTeamNames(a);
  const teamsB = getTeamNames(b);

  if (!teamsA.home || !teamsA.away ||
      !teamsB.home || !teamsB.away) return false;

  const direct =
    teamsA.home === teamsB.home && teamsA.away === teamsB.away;
  const reversed =
    teamsA.home === teamsB.away && teamsA.away === teamsB.home;

  if (!direct && !reversed) return false;

  const timeA = getKickoff(a);
  const timeB = getKickoff(b);

  if (timeA === null || timeB === null) return false;

  return Math.abs(timeA - timeB) <= 2 * 60 * 60 * 1000;
}

function mergeFootballFixtures(sportScoreMatches, sportApiMatches) {
  const sportApi = Array.isArray(sportApiMatches) ? sportApiMatches : [];
  const sportScore = Array.isArray(sportScoreMatches) ? sportScoreMatches : [];

  const merged = [];

  // La source prioritaire est insérée en premier.
  for (const item of sportApi) {
    const fixture = normalizeFixture(item, 'SportAPI.ai');
    if (fixture) merged.push(fixture);
  }

  for (const item of sportScore) {
    const fixture = normalizeFixture(item, 'SportScore');
    if (!fixture) continue;

    const duplicateIndex = merged.findIndex(existing =>
      sameFixture(existing, fixture)
    );

    if (duplicateIndex === -1) {
      merged.push(fixture);
    }
    // En cas de doublon, on conserve la version SportAPI.ai.
  }

  return merged;
}

module.exports = {
  normalizeName,
  normalizeFixture,
  sameFixture,
  mergeFootballFixtures
};

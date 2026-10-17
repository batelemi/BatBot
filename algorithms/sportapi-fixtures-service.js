'use strict';

const API_BASE = 'https://sportapi.ai/api';
const REQUEST_TIMEOUT_MS = 15000;

function normalizeFixture(match) {
  if (!match || typeof match !== 'object') return null;

  const homeObj = match.teams?.home || match.home_team_data ||
    match.homeTeam ||
    (match.home_team && typeof match.home_team === 'object' ? match.home_team : null) ||
    (match.home && typeof match.home === 'object' ? match.home : {});
  const awayObj = match.teams?.away || match.away_team_data ||
    match.awayTeam ||
    (match.away_team && typeof match.away_team === 'object' ? match.away_team : null) ||
    (match.away && typeof match.away === 'object' ? match.away : {});
  const cleanTeamName = value => {
    if (typeof value !== 'string') return '';
    return value
      .replace(/^\s*(?:[\w-]+\.(?:png|jpe?g|webp|svg)\s*)+/i, '')
      .trim();
  };
  const home = cleanTeamName(
    (typeof match.home_team === 'string' && match.home_team) ||
    homeObj.name || (typeof match.home === 'string' ? match.home : '')
  );
  const away = cleanTeamName(
    (typeof match.away_team === 'string' && match.away_team) ||
    awayObj.name || (typeof match.away === 'string' ? match.away : '')
  );
  const id = match.id ?? match.fixture?.id;
  const date = String(
    match.kickoff_utc || match.datetime || match.date || match.fixture?.date || ''
  ).trim();

  if (!home || !away || id == null || !date) return null;

  const rawStatus = String(
    match.status?.short || match.status?.long || match.status ||
    match.fixture?.status?.short || match.fixture?.status?.long ||
    match.status_code || match.state || ''
  ).trim().toUpperCase().replace(/[\s.-]+/g, '_');

  const finishedStatuses = new Set([
    'FT', 'AET', 'PEN', 'PENS', 'FINISHED', 'FULL_TIME', 'COMPLETED',
    'AFTER_EXTRA_TIME', 'AFTER_PENALTIES', 'ENDED'
  ]);
  const blockedStatuses = new Set([
    'CANCELLED', 'CANCELED', 'POSTPONED', 'ABANDONED', 'SUSPENDED'
  ]);
  const scheduledStatuses = new Set([
    'SCHEDULED', 'NS', 'NOT_STARTED', 'TIMED', 'UPCOMING', 'FIXTURE'
  ]);
  const liveStatuses = new Set([
    'LIVE', '1H', '2H', 'HT', 'ET', 'IN_PLAY', 'PAUSED',
    'IN_PROGRESS', 'FIRST_HALF', 'SECOND_HALF', 'HALF_TIME',
    'HALFTIME', 'EXTRA_TIME', 'PENALTIES'
  ]);

  let status = 'UNKNOWN';
  if (finishedStatuses.has(rawStatus)) status = 'FT';
  else if (blockedStatuses.has(rawStatus)) status = 'CANCELLED';
  else if (scheduledStatuses.has(rawStatus)) status = 'NS';
  else if (liveStatuses.has(rawStatus)) status = 'LIVE';

  const homeScore = match.home_score ?? match.goals?.home ?? match.score?.home;
  const awayScore = match.away_score ?? match.goals?.away ?? match.score?.away;
  const validScore =
    homeScore != null && awayScore != null &&
    homeScore !== '' && awayScore !== '' &&
    Number.isFinite(Number(homeScore)) &&
    Number.isFinite(Number(awayScore)) &&
    Number(homeScore) >= 0 && Number(awayScore) >= 0;

  const homeId = match.home_id ?? match.home_team_id ??
    match.homeTeam?.id ?? match.home_team_data?.id ?? homeObj.id ?? null;
  const awayId = match.away_id ?? match.away_team_id ??
    match.awayTeam?.id ?? match.away_team_data?.id ?? awayObj.id ?? null;
  // SportAPI peut exposer les visuels sous plusieurs noms selon le format de réponse.
  // On conserve en priorité les URL fournies par SportAPI.ai.
  const homeLogo = match.home_logo || match.home_team_logo ||
    match.homeTeam?.logo || match.homeTeam?.crest || match.homeTeam?.image ||
    match.homeTeam?.logoUrl || match.home_team_data?.logo ||
    match.home_team_data?.crest || match.home_team_data?.image ||
    homeObj.logo || homeObj.crest || homeObj.image || homeObj.logo_url ||
    homeObj.logoUrl || homeObj.image_url || homeObj.imageUrl ||
    homeObj.badge || homeObj.flag || null;
  const awayLogo = match.away_logo || match.away_team_logo ||
    match.awayTeam?.logo || match.awayTeam?.crest || match.awayTeam?.image ||
    match.awayTeam?.logoUrl || match.away_team_data?.logo ||
    match.away_team_data?.crest || match.away_team_data?.image ||
    awayObj.logo || awayObj.crest || awayObj.image || awayObj.logo_url ||
    awayObj.logoUrl || awayObj.image_url || awayObj.imageUrl ||
    awayObj.badge || awayObj.flag || null;
  const leagueObj = match.league || match.competition || {};
  const leagueId = match.league_id ?? leagueObj.id ?? null;
  const leagueName = (typeof leagueObj === 'object' ? leagueObj.name : leagueObj) ||
    match.league_name || 'Compétition inconnue';
  const leagueEmblem = match.league_emblem || match.competition_emblem ||
    match.league_logo || match.competition_logo ||
    (typeof leagueObj === 'object' && leagueObj
      ? leagueObj.emblem || leagueObj.logo || leagueObj.image || leagueObj.crest ||
        leagueObj.logo_url || leagueObj.logoUrl || leagueObj.image_url || leagueObj.imageUrl
      : null) || null;

  return {
    fixture: {
      id: String(id),
      date,
      status: {
        short: status,
        long: String(match.status?.long || match.status?.short || match.status || 'Statut inconnu')
      }
    },
    teams: {
      home: {
        id: homeId == null ? null : String(homeId),
        name: home,
        logo: homeLogo,
        flag: homeObj.flag || null,
        slug: homeObj.slug || null
      },
      away: {
        id: awayId == null ? null : String(awayId),
        name: away,
        logo: awayLogo,
        flag: awayObj.flag || null,
        slug: awayObj.slug || null
      }
    },
    league: {
      id: leagueId == null ? null : String(leagueId),
      name: String(leagueName),
      emblem: leagueEmblem
    },
    goals: {
      home: validScore ? Number(homeScore) : null,
      away: validScore ? Number(awayScore) : null
    },
    sportapi: {
      status: rawStatus,
      result: match.result ?? null,
      rawId: id
    },
    eligibility: {
      finished: status === 'FT',
      cancelled: status === 'CANCELLED',
      live: status === 'LIVE',
      scheduled: status === 'NS',
      canAnalyze: status === 'NS' || status === 'LIVE'
    }
  };
}

async function fetchFixtures(date, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Date invalide : format AAAA-MM-JJ attendu.');
  }

  const apiKey = options.apiKey || process.env.SPORTAPI_KEY;
  if (!apiKey) {
    throw new Error('SPORTAPI_KEY absente de l’environnement.');
  }

  const url = `${API_BASE}/fixtures/date/${encodeURIComponent(date)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Api-Key': apiKey
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`SportAPI.ai a répondu HTTP ${response.status}.`);
  }

  const payload = await response.json();

  if (payload?.success !== true || !Array.isArray(payload.data)) {
    throw new Error('Réponse SportAPI.ai inattendue : success/data manquant.');
  }

  const fixtures = [];
  let rejected = 0;

  for (const item of payload.data) {
    const normalized = normalizeFixture(item);
    if (normalized) fixtures.push(normalized);
    else rejected++;
  }

  return {
    source: 'SportAPI.ai',
    date,
    count: fixtures.length,
    rejected,
    fixtures
  };
}

module.exports = { normalizeFixture, fetchFixtures };

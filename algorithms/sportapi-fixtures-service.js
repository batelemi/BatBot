'use strict';

const API_BASE = 'https://sportapi.ai/api';
const REQUEST_TIMEOUT_MS = 15000;

function normalizeFixture(match) {
  if (!match || typeof match !== 'object') return null;

  const home = String(match.home_team || '').trim();
  const away = String(match.away_team || '').trim();
  const id = match.id;
  const date = String(
    match.kickoff_utc || match.datetime || match.date || ''
  ).trim();

  if (!home || !away || id == null || !date) return null;

  const rawStatus = String(match.status || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  const finishedStatuses = new Set([
    'FT', 'AET', 'PEN', 'FINISHED', 'FULL_TIME', 'COMPLETED',
    'AFTER_EXTRA_TIME', 'AFTER_PENALTIES'
  ]);

  const blockedStatuses = new Set([
    'CANCELLED', 'CANCELED', 'POSTPONED',
    'ABANDONED', 'SUSPENDED'
  ]);

  const scheduledStatuses = new Set([
    'SCHEDULED', 'NS', 'NOT_STARTED', 'TIMED', 'UPCOMING'
  ]);

  const liveStatuses = new Set([
    'LIVE', '1H', '2H', 'HT', 'ET', 'IN_PLAY', 'PAUSED',
    'IN_PROGRESS', 'FIRST_HALF', 'SECOND_HALF',
    'HALF_TIME', 'HALFTIME', 'EXTRA_TIME'
  ]);

  let status = 'UNKNOWN';
  if (finishedStatuses.has(rawStatus)) status = 'FT';
  else if (blockedStatuses.has(rawStatus)) status = 'CANCELLED';
  else if (scheduledStatuses.has(rawStatus)) status = 'NS';
  else if (liveStatuses.has(rawStatus)) status = 'LIVE';

  const validScore =
    match.home_score != null &&
    match.away_score != null &&
    Number.isFinite(Number(match.home_score)) &&
    Number.isFinite(Number(match.away_score)) &&
    Number(match.home_score) >= 0 &&
    Number(match.away_score) >= 0;

  return {
    fixture: {
      id: String(id),
      date,
      status: {
        short: status,
        long: String(match.status || 'Statut inconnu')
      }
    },
    teams: {
      home: {
        id: match.home_id == null ? null : String(match.home_id),
        name: home,
        logo: match.home_logo || null
      },
      away: {
        id: match.away_id == null ? null : String(match.away_id),
        name: away,
        logo: match.away_logo || null
      }
    },
    league: {
      id: match.league_id == null ? null : String(match.league_id),
      name: String(match.league_name || 'Compétition inconnue')
    },
    goals: {
      home: validScore ? Number(match.home_score) : null,
      away: validScore ? Number(match.away_score) : null
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

'use strict';

const API_BASE = 'https://api.football-data.org/v4';
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map();
const inFlight = new Map();

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isValidImageUrl(value) {
  if (typeof value !== 'string') return false;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'crests.football-data.org' &&
      /\.(png|svg|webp|jpe?g)$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function findExactMatch(items, name, nameSelector) {
  const wanted = normalizeName(name);
  if (!wanted || !Array.isArray(items)) return null;

  return items.find(item =>
    normalizeName(nameSelector(item)) === wanted
  ) || null;
}

function normalizeTeamVisual(team) {
  if (!team || typeof team !== 'object') return null;

  return {
    id: team.id == null ? null : String(team.id),
    name: String(team.name || ''),
    logo: isValidImageUrl(team.crest) ? team.crest : null
  };
}

function normalizeCompetitionVisual(competition) {
  if (!competition || typeof competition !== 'object') return null;

  return {
    id: competition.id == null ? null : String(competition.id),
    name: String(competition.name || ''),
    code: String(competition.code || ''),
    logo: isValidImageUrl(competition.emblem)
      ? competition.emblem
      : null
  };
}

async function fetchJson(path) {
  const token = process.env.FOOTBALL_DATA_TOKEN;

  if (!token) {
    const error = new Error('FOOTBALL_DATA_TOKEN absente');
    error.code = 'TOKEN_MISSING';
    throw error;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: {
      'X-Auth-Token': token,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const error = new Error(
      `football-data.org a répondu HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function getCached(key, loader) {
  const existing = cache.get(key);

  if (existing && existing.expiresAt > Date.now()) {
    return existing.value;
  }

  // Plusieurs matchs peuvent partager la même requête en cours.
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    const value = await loader();

    cache.set(key, {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    return value;
  })();

  inFlight.set(key, request);

  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) {
      inFlight.delete(key);
    }
  }
}

async function fetchVisualsForFixture(leagueName, homeName, awayName) {
  if (!leagueName || !homeName || !awayName) {
    return {
      homeLogo: null,
      awayLogo: null,
      competitionLogo: null
    };
  }

  try {
    const competitions = await getCached('competitions', async () => {
      const data = await fetchJson('/competitions/');
      return Array.isArray(data.competitions) ? data.competitions : [];
    });

    const competition = findExactMatch(
      competitions,
      leagueName,
      item => item.name
    ) || findExactMatch(
      competitions,
      leagueName,
      item => item.code
    );

    if (!competition || !competition.code) {
      return {
        homeLogo: null,
        awayLogo: null,
        competitionLogo: null
      };
    }

    const teams = await getCached(
      `teams:${competition.code}`,
      async () => {
        const data = await fetchJson(
          `/competitions/${encodeURIComponent(competition.code)}/teams`
        );
        return Array.isArray(data.teams) ? data.teams : [];
      }
    );

    const home = findExactMatch(teams, homeName, item => item.name);
    const away = findExactMatch(teams, awayName, item => item.name);
    const visualCompetition = normalizeCompetitionVisual(competition);

    return {
      homeLogo: normalizeTeamVisual(home)?.logo || null,
      awayLogo: normalizeTeamVisual(away)?.logo || null,
      competitionLogo: visualCompetition?.logo || null
    };
  } catch (error) {
    // Le service visuel ne doit jamais bloquer les matchs ou les analyses.
    return {
      homeLogo: null,
      awayLogo: null,
      competitionLogo: null
    };
  }
}

module.exports = {
  normalizeName,
  isValidImageUrl,
  findExactMatch,
  normalizeTeamVisual,
  normalizeCompetitionVisual,
  fetchVisualsForFixture
};

'use strict';

const API_BASE = 'https://api.football-data.org/v4';
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map();
const inFlight = new Map();
let lastVisualErrorKey = '';
let lastVisualErrorAt = 0;

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

  const matches = items.filter(item =>
    normalizeName(nameSelector(item)) === wanted
  );

  return matches.find(item => normalizeTeamVisual(item)?.logo) ||
    matches[0] ||
    null;
}

const TEAM_NAME_ALIASES = {
  telstar: ['SC Telstar'],
  feyenoord: ['Feyenoord Rotterdam']
};

function findTeamMatch(teams, teamName) {
  if (!Array.isArray(teams) || !normalizeName(teamName)) return null;

  const directMatches = teams.filter(team =>
    normalizeName(team.name) === normalizeName(teamName)
  );

  const directWithLogo = directMatches.find(team =>
    normalizeTeamVisual(team)?.logo
  );

  if (directWithLogo) return directWithLogo;
  if (directMatches.length) {
    const aliases = TEAM_NAME_ALIASES[normalizeName(teamName)] || [];
    for (const alias of aliases) {
      const aliasMatches = teams.filter(team =>
        normalizeName(team.name) === normalizeName(alias)
      );
      const aliasWithLogo = aliasMatches.find(team =>
        normalizeTeamVisual(team)?.logo
      );
      if (aliasWithLogo) return aliasWithLogo;
    }
    return directMatches[0];
  }

  const aliases = TEAM_NAME_ALIASES[normalizeName(teamName)] || [];
  for (const alias of aliases) {
    const match = findExactMatch(teams, alias, team => team.name);
    if (match) return match;
  }

  return null;
}

const COMPETITION_NAME_ALIASES = {
  'dutch eredivisie': ['Eredivisie', 'DED']
};

function findCompetitionMatch(competitions, leagueName) {
  const directMatch = findExactMatch(
    competitions, leagueName, item => item.name
  ) || findExactMatch(
    competitions, leagueName, item => item.code
  );

  if (directMatch) return directMatch;

  const aliases = COMPETITION_NAME_ALIASES[normalizeName(leagueName)] || [];

  for (const alias of aliases) {
    const match = findExactMatch(
      competitions, alias, item => item.name
    ) || findExactMatch(
      competitions, alias, item => item.code
    );

    if (match) return match;
  }

  return null;
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

    const competition = findCompetitionMatch(competitions, leagueName);

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

    const home = findTeamMatch(teams, homeName);
    const away = findTeamMatch(teams, awayName);
    const visualCompetition = normalizeCompetitionVisual(competition);

    return {
      homeLogo: normalizeTeamVisual(home)?.logo || null,
      awayLogo: normalizeTeamVisual(away)?.logo || null,
      competitionLogo: visualCompetition?.logo || null
    };
  } catch (error) {
    // Diagnostic limité : jamais de token, d'URL complète ou de données sensibles.
    const errorKey = String(error?.status || error?.code || error?.name || "ERROR");
    const now = Date.now();

    if (
      errorKey !== lastVisualErrorKey ||
      now - lastVisualErrorAt > 5 * 60 * 1000
    ) {
      console.warn(
        "[football-visuals] échec API ; catégorie=" +
        errorKey +
        (error?.status ? " ; HTTP=" + error.status : "")
      );
      lastVisualErrorKey = errorKey;
      lastVisualErrorAt = now;
    }

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
  findTeamMatch,
  normalizeTeamVisual,
  normalizeCompetitionVisual,
  findCompetitionMatch,
  fetchVisualsForFixture
};

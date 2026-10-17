'use strict';

const API_BASE = 'https://v3.football.api-sports.io';
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
      url.hostname === 'media.api-sports.io' &&
      /^\/football\/(teams|leagues)\/[^/]+\.(png|svg|webp|jpe?g)$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

async function fetchJson(path) {
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    const error = new Error('API_FOOTBALL_KEY absente');
    error.code = 'TOKEN_MISSING';
    throw error;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: {
      'x-apisports-key': apiKey,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const error = new Error(`API-Football HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();

  if (data?.errors && Object.keys(data.errors).length > 0) {
    const error = new Error('API-Football a signalé une erreur');
    error.code = 'API_ERROR';
    throw error;
  }

  return data;
}

async function getCached(key, loader) {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.value;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

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

async function searchTeamLogo(teamName) {
  const wanted = normalizeName(teamName);
  if (!wanted) return null;

  try {
    return await getCached(`team:${wanted}`, async () => {
      const data = await fetchJson(
        `/teams?search=${encodeURIComponent(String(teamName).trim())}`
      );

      const teams = Array.isArray(data?.response) ? data.response : [];
      const exact = teams.find(item =>
        normalizeName(item?.team?.name) === wanted
      );

      const logo = exact?.team?.logo;
      return isValidImageUrl(logo) ? logo : null;
    });
  } catch (error) {
    console.warn(
      '[api-football-visuals] recherche équipe indisponible ; catégorie=' +
      String(error?.code || error?.status || error?.name || 'ERROR')
    );
    return null;
  }
}

async function searchCompetitionLogo(competitionName) {
  const wanted = normalizeName(competitionName);
  if (!wanted) return null;

  try {
    return await getCached(`league:${wanted}`, async () => {
      const data = await fetchJson(
        `/leagues?search=${encodeURIComponent(String(competitionName).trim())}`
      );

      const leagues = Array.isArray(data?.response) ? data.response : [];
      const exact = leagues.find(item =>
        normalizeName(item?.league?.name) === wanted
      );

      const logo = exact?.league?.logo;
      return isValidImageUrl(logo) ? logo : null;
    });
  } catch (error) {
    console.warn(
      '[api-football-visuals] recherche compétition indisponible ; catégorie=' +
      String(error?.code || error?.status || error?.name || 'ERROR')
    );
    return null;
  }
}

module.exports = {
  normalizeName,
  isValidImageUrl,
  searchTeamLogo,
  searchCompetitionLogo
};

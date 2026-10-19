"use strict";

const API_BASE = "https://sportscore.com/api/v1";
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

function extractMatches(data) {
  const candidates = [
    data?.matches,
    data?.fixtures,
    data?.data?.matches,
    data?.data?.fixtures,
    data?.response?.matches,
    data?.response?.fixtures,
    data?.results,
    data?.data
  ];

  return candidates.find(Array.isArray) || [];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`SportScore HTTP ${response.status}`);
  }

  return response.json();
}

function readName(team) {
  if (typeof team === "string") return clean(team);
  return clean(team?.name || team?.team?.name || team?.short_name);
}


const teamSlugCache = new Map();

async function resolveTeamSlug(teamName) {
  const name = clean(teamName);
  if (!name) return null;

  const cacheKey = name.toLocaleLowerCase();
  if (teamSlugCache.has(cacheKey)) {
    return teamSlugCache.get(cacheKey);
  }

  const params = new URLSearchParams({
    sport: "football",
    q: name,
    limit: "20"
  });

  const payload = await fetchJson(
    `${API_BASE}/search/?${params.toString()}`
  );

  const candidates = [
    ...(Array.isArray(payload?.teams) ? payload.teams : []),
    ...(Array.isArray(payload?.data?.teams) ? payload.data.teams : [])
  ];

  const exact = candidates.filter(team =>
    clean(team?.name).toLocaleLowerCase() === cacheKey &&
    clean(team?.slug)
  );

  const slug = exact.length === 1 ? clean(exact[0].slug) : null;

  // Cache positif uniquement : une erreur réseau ne doit pas
  // être mémorisée comme une absence de correspondance.
  if (slug) teamSlugCache.set(cacheKey, slug);

  return slug;
}

function readSlug(team) {
  if (!team || typeof team === "string") return null;
  return clean(team?.slug || team?.team?.slug) || null;
}

function readSourceId(team) {
  if (!team || typeof team === "string") return null;
  const id = team?.id ?? team?.team?.id;
  return id === null || id === undefined || clean(id) === ""
    ? null
    : String(id);
}

function readScore(match, side) {
  const direct = match?.[`${side}_score`];
  const team = match?.[side] || match?.teams?.[side];
  const score =
    direct ??
    team?.score ??
    match?.score?.[side] ??
    match?.scores?.[side];

  if (score === null || score === undefined || score === "") return null;

  const number = Number(score);
  return Number.isFinite(number) ? number : null;
}

function readStatus(match, date) {
  const raw = match?.status?.short ||
    match?.status?.name ||
    match?.status ||
    match?.state ||
    match?.status_text ||
    match?.statusText ||
    "";

  const value = clean(raw).toLowerCase().replace(/[_-]+/g, " ");

  if (/cancel|postpon|abandon|suspend/.test(value)) return "UNKNOWN";
  if (/finished|full time|complete|ended|final|after extra|penalt|^ft$/.test(value)) return "FT";
  if (/live|in progress|in play|first half|second half|half time|^1h$|^2h$|^ht$|extra time/.test(value)) return "LIVE";
  if (/^(ns|scheduled|not started|upcoming|fixture|timed)$/.test(value)) return "NS";

  // Un statut explicite inconnu ne doit pas être accepté comme programmé.
  if (value) return "UNKNOWN";

  const timestamp = Date.parse(
    match?.date || match?.datetime || match?.kickoff_utc ||
    match?.fixture?.date || ""
  );

  if (Number.isFinite(timestamp)) {
    return timestamp > Date.now() ? "NS" : "UNKNOWN";
  }

  return date >= new Date().toISOString().slice(0, 10) ? "UNKNOWN" : "UNKNOWN";
}

function normalizeFixture(match) {
  if (!match || typeof match !== "object") return null;

  const home = match?.home || match?.teams?.home || match?.home_team || match?.homeTeam;
  const away = match?.away || match?.teams?.away || match?.away_team || match?.awayTeam;

  const homeName = readName(home);
  const awayName = readName(away);
  if (!homeName || !awayName) return null;

  const competition = match?.competition || match?.league || match?.tournament || {};
  const competitionName = typeof competition === "string"
    ? competition
    : clean(competition?.name || match?.competition_name || match?.league_name) || "Compétition";

  const date = match?.time || match?.date || match?.datetime ||
    match?.kickoff_utc || match?.fixture?.date || null;

  const rawId = match?.id ?? match?.fixture?.id ?? match?.event?.id ?? null;
  const matchUrl = match?.url || match?.fixture?.url || null;
  const urlSlug = typeof matchUrl === "string"
    ? matchUrl.match(/\/football\/match\/([^?#]+)\/?$/)?.[1] || null
    : null;
  const slug = match?.slug || match?.fixture?.slug ||
    match?.url_slug || urlSlug;

  const homeSlug = readSlug(home);
  const awaySlug = readSlug(away);
  const status = readStatus(match, date ? String(date).slice(0, 10) : "");

  const homeLogo = match?.home_logo || home?.logo || home?.image || null;
  const awayLogo = match?.away_logo || away?.logo || away?.image || null;
  const competitionLogo = match?.competition_logo ||
    match?.league_logo || competition?.logo || competition?.image || null;

  return {
    fixture: {
      id: rawId == null ? null : String(rawId),
      slug,
      url: matchUrl,
      date,
      status: { short: status, long: clean(match?.status_text || match?.statusText || status) }
    },
    teams: {
      home: {
        id: readSourceId(home) || homeSlug,
        name: homeName,
        logo: homeLogo,
        slug: homeSlug
      },
      away: {
        id: readSourceId(away) || awaySlug,
        name: awayName,
        logo: awayLogo,
        slug: awaySlug
      }
    },
    league: {
      id: competition?.id == null ? (competition?.slug || null) : String(competition.id),
      name: competitionName,
      country: competition?.country?.name || competition?.country || null,
      emblem: competitionLogo
    },
    goals: {
      home: readScore(match, "home"),
      away: readScore(match, "away")
    },
    home_logo: homeLogo,
    away_logo: awayLogo,
    source: "SportScore",
    sportscore: {
      slug,
      homeSlug,
      awaySlug,
      rawStatus: clean(match?.status?.short || match?.status?.name || match?.status || match?.state || "")
    }
  };
}


async function enrichFixtureTeamSlugs(fixtures) {
  const uniqueNames = [...new Set(
    fixtures.flatMap(item => [
      item.teams.home.slug ? null : item.teams.home.name,
      item.teams.away.slug ? null : item.teams.away.name
    ]).filter(Boolean)
  )];

  const resolved = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueNames.length) {
      const index = cursor++;
      const name = uniqueNames[index];

      try {
        resolved.set(name, await resolveTeamSlug(name));
      } catch (error) {
        console.warn(
          `[SportScore] Slug non résolu pour "${name}": ${error.message}`
        );
        resolved.set(name, null);
      }
    }
  }

  await Promise.all([worker(), worker()]);

  for (const item of fixtures) {
    const homeName = item.teams.home.name;
    const awayName = item.teams.away.name;

    const homeSlug = item.teams.home.slug || resolved.get(homeName) || null;
    const awaySlug = item.teams.away.slug || resolved.get(awayName) || null;

    item.teams.home.slug = homeSlug;
    item.teams.away.slug = awaySlug;
    item.sportscore.homeSlug = homeSlug;
    item.sportscore.awaySlug = awaySlug;
  }

  return fixtures;
}

async function fetchSportScoreFixtures(date, statusFilter = "") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    throw new Error("Date invalide. Format attendu : YYYY-MM-DD.");
  }

  const allowedFilters = new Set(["", "live", "finished", "upcoming"]);
  const filter = allowedFilters.has(statusFilter) ? statusFilter : "";
  const key = `${date}:${filter}`;
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }

  const params = new URLSearchParams({
    sport: "football",
    date,
    limit: "200"
  });

  const url = `${API_BASE}/fixtures/?${params.toString()}`;
  const payload = await fetchJson(url);

  const fixtures = extractMatches(payload)
    .map(normalizeFixture)
    .filter(Boolean);



  const filtered = fixtures.filter(item => {
    const status = item.fixture.status.short;
    if (filter === "live") return status === "LIVE";
    if (filter === "finished") return status === "FT";
    if (filter === "upcoming") return status === "NS";
    return true;
  });

  const value = {
    source: "SportScore",
    date,
    count: filtered.length,
    updated: new Date().toISOString(),
    fixtures: filtered
  };

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...value, cached: false };
}

module.exports = {
  fetchSportScoreFixtures,
  normalizeFixture,
  extractMatches,
  resolveTeamSlug
};

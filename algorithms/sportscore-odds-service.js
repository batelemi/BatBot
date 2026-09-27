/**
 * BATBOT — Service SportScore + moteur de probabilités
 *
 * Version corrigée :
 * - utilise /api/v1/team/ pour récupérer directement le calendrier
 *   récent et historique d'une équipe ;
 * - garde un fallback par journées afin de ne pas dépendre d'un seul
 *   format de réponse SportScore ;
 * - conserve le moteur Poisson v3 existant ;
 * - ne fabrique aucune probabilité si les données vérifiables sont
 *   insuffisantes.
 */

"use strict";

const {
  calculateOdds,
  MIN_MATCHES
} = require("./odds-engine");

const SPORT = "football";
const API_BASE = "https://sportscore.com/api/v1";

const TARGET_MATCHES = 10;
const TEAM_ENDPOINT_LIMIT = 50;
const MAX_LOOKBACK_DAYS = 365;
const DATE_CONCURRENCY = 6;
const CACHE_TTL_MS = 5 * 60 * 1000;

const teamHistoryCache = new Map();


// ============================================================
// TEXTE
// ============================================================

function cleanText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function getSignificantTokens(value) {
  const ignoredWords = new Set([
    "fc", "cf", "afc", "ac", "sc", "as", "rc",
    "fk", "sk", "de", "du", "des", "the"
  ]);

  return cleanText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !ignoredWords.has(token));
}


// ============================================================
// CORRESPONDANCE ÉQUIPE
// ============================================================

function calculateTeamMatchScore(wantedName, candidateName) {
  const wanted = cleanText(wantedName);
  const candidate = cleanText(candidateName);

  if (candidate === wanted) return 1000;

  const wantedTokens = getSignificantTokens(wantedName);
  const candidateTokens = getSignificantTokens(candidateName);

  if (!wantedTokens.length || !candidateTokens.length) return 0;

  const wantedSet = new Set(wantedTokens);
  const candidateSet = new Set(candidateTokens);

  if (!wantedTokens.every(token => candidateSet.has(token))) {
    return 0;
  }

  const forbiddenVariants = new Set([
    "women", "woman", "ladies", "girls",
    "youth", "u19", "u20", "u21", "u23",
    "ii", "iii", "legends", "indoor",
    "academy", "reserves", "reserve", "b"
  ]);

  if (candidateTokens.some(token => forbiddenVariants.has(token))) {
    return 0;
  }

  const extraTokens = candidateTokens.filter(
    token => !wantedSet.has(token)
  );

  let score = 500 - extraTokens.length * 40;

  if (
    candidate.startsWith(`${wanted} fc`) ||
    candidate.endsWith(` ${wanted} fc`) ||
    candidate.startsWith(`fc ${wanted}`) ||
    candidate.startsWith(`cf ${wanted}`) ||
    candidate.startsWith(`afc ${wanted}`)
  ) {
    score += 100;
  }

  return Math.max(score, 1);
}


// ============================================================
// API SPORTSCORE
// ============================================================

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `SportScore HTTP ${response.status} : ${response.statusText}`
    );
  }

  return response.json();
}


// ============================================================
// RECHERCHE ÉQUIPE
// ============================================================

async function searchTeam(teamName) {
  const url =
    `${API_BASE}/search/` +
    `?q=${encodeURIComponent(teamName)}` +
    `&sport=${SPORT}` +
    `&limit=20`;

  const data = await fetchJson(url);

  const candidates = [
    data?.teams,
    data?.data?.teams,
    data?.results?.teams,
    data?.data?.results?.teams,
    data?.results,
    data?.data
  ];

  const teams = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;

    for (const team of candidate) {
      const name = team?.name || team?.team?.name || "";
      const slug = team?.slug || team?.team?.slug || "";

      if (!name || !slug) continue;

      const key = `${cleanText(name)}|${cleanText(slug)}`;
      if (seen.has(key)) continue;

      seen.add(key);
      teams.push({ ...team, name, slug });
    }
  }

  if (!teams.length) {
    throw new Error(`Aucune équipe trouvée pour "${teamName}".`);
  }

  const wanted = cleanText(teamName);

  const exact = teams.filter(
    team => cleanText(team.name) === wanted
  );

  if (exact.length === 1) return exact[0];

  const ranked = teams
    .map(team => ({
      team,
      score: calculateTeamMatchScore(teamName, team.name)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    throw new Error(
      `Impossible d'identifier précisément "${teamName}".`
    );
  }

  if (
    ranked.length === 1 ||
    ranked[0].score > ranked[1].score
  ) {
    return ranked[0].team;
  }

  throw new Error(
    `Impossible d'identifier précisément "${teamName}".`
  );
}


// ============================================================
// EXTRACTION DES MATCHS
// ============================================================

function extractMatches(data) {
  const candidates = [
    data?.matches,
    data?.fixtures,
    data?.data?.matches,
    data?.data?.fixtures,
    data?.response?.matches,
    data?.response?.fixtures,
    data?.team?.matches,
    data?.team?.fixtures,
    data?.data?.team?.matches,
    data?.data?.team?.fixtures,
    data?.results,
    data?.data
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}


// ============================================================
// DATES
// ============================================================

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function subtractUtcDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() - days);
  return copy;
}


// ============================================================
// VALIDATION MATCH
// ============================================================

function hasRealScore(match) {
  const homeScore = match?.home_score;
  const awayScore = match?.away_score;

  return (
    homeScore !== null &&
    homeScore !== undefined &&
    awayScore !== null &&
    awayScore !== undefined &&
    Number.isFinite(Number(homeScore)) &&
    Number.isFinite(Number(awayScore)) &&
    Number(homeScore) >= 0 &&
    Number(awayScore) >= 0
  );
}

function isFinished(match) {
  const status = cleanText(
    match?.status ||
    match?.status_text ||
    match?.state
  );

  return (
    status === "finished" ||
    status === "ft" ||
    status.includes("finished")
  );
}

function matchBelongsToTeam(match, team) {
  const wanted = cleanText(team.name);
  const home = cleanText(match?.home);
  const away = cleanText(match?.away);

  if (home === wanted || away === wanted) return true;

  /*
   * Certains calendriers peuvent présenter une variante légère
   * du nom. On accepte uniquement une correspondance de tokens
   * suffisamment forte et on refuse les équipes dérivées.
   */
  return (
    calculateTeamMatchScore(team.name, match?.home || "") > 0 ||
    calculateTeamMatchScore(team.name, match?.away || "") > 0
  );
}

function getMatchTimestamp(match) {
  const candidates = [
    match?.time,
    match?.start_time,
    match?.datetime,
    match?.date
  ];

  for (const value of candidates) {
    const timestamp = new Date(value || 0).getTime();
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp;
    }
  }

  return 0;
}


// ============================================================
// HISTORIQUE D'ÉQUIPE
// ============================================================

async function fetchTeamScheduleFromEndpoint(team) {
  const url =
    `${API_BASE}/team/` +
    `?sport=${SPORT}` +
    `&slug=${encodeURIComponent(team.slug)}` +
    `&limit=${TEAM_ENDPOINT_LIMIT}`;

  const data = await fetchJson(url);
  const matches = extractMatches(data);

  return matches
    .filter(match => hasRealScore(match))
    .filter(match => isFinished(match))
    .filter(match => matchBelongsToTeam(match, team));
}

async function fetchTeamScheduleByDays(team) {
  const collected = [];
  const seen = new Set();

  const today = new Date();
  let cursor = 0;

  async function worker() {
    while (
      cursor < MAX_LOOKBACK_DAYS &&
      collected.length < TARGET_MATCHES
    ) {
      const daysAgo = cursor++;
      const date = subtractUtcDays(today, daysAgo);
      const dateText = formatUtcDate(date);

      const url =
        `${API_BASE}/fixtures/` +
        `?sport=${SPORT}` +
        `&date=${dateText}` +
        `&status=finished` +
        `&team=${encodeURIComponent(team.slug)}` +
        `&limit=200`;

      try {
        const data = await fetchJson(url);
        const matches = extractMatches(data);

        for (const match of matches) {
          if (!hasRealScore(match) || !isFinished(match)) continue;
          if (!matchBelongsToTeam(match, team)) continue;

          const key =
            match?.slug ||
            match?.url ||
            `${match?.home}|${match?.away}|${match?.time}`;

          if (seen.has(key)) continue;

          seen.add(key);
          collected.push(match);
        }
      } catch (_) {
        // Une journée indisponible ne bloque pas toute l'analyse.
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DATE_CONCURRENCY, MAX_LOOKBACK_DAYS) },
      () => worker()
    )
  );

  return collected;
}

async function fetchTeamSchedule(team) {
  const cacheKey = cleanText(team.slug);
  const cached = teamHistoryCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.matches;
  }

  let matches = [];

  /*
   * 1. Méthode principale :
   *    endpoint officiel Team schedule.
   *
   * SportScore documente /api/v1/team/ comme l'endpoint
   * du calendrier passé + à venir d'une équipe, avec un
   * maximum de 50 éléments.
   */
  try {
    matches = await fetchTeamScheduleFromEndpoint(team);
  } catch (_) {
    matches = [];
  }

  /*
   * 2. Si l'endpoint ne donne pas assez de matchs terminés,
   *    on complète avec les journées historiques.
   */
  if (matches.length < TARGET_MATCHES) {
    const fallbackMatches = await fetchTeamScheduleByDays(team);

    const seen = new Set(
      matches.map(
        match =>
          match?.slug ||
          match?.url ||
          `${match?.home}|${match?.away}|${match?.time}`
      )
    );

    for (const match of fallbackMatches) {
      const key =
        match?.slug ||
        match?.url ||
        `${match?.home}|${match?.away}|${match?.time}`;

      if (seen.has(key)) continue;

      seen.add(key);
      matches.push(match);
    }
  }

  const result = matches
    .filter(match => hasRealScore(match))
    .filter(match => isFinished(match))
    .filter(match => matchBelongsToTeam(match, team))
    .sort(
      (a, b) => getMatchTimestamp(b) - getMatchTimestamp(a)
    )
    .slice(0, TARGET_MATCHES);

  teamHistoryCache.set(cacheKey, {
    matches: result,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  return result;
}


// ============================================================
// BUTS
// ============================================================

function getGoalsForAndAgainst(match, team) {
  const home = cleanText(match?.home);
  const away = cleanText(match?.away);
  const wanted = cleanText(team.name);

  const homeScore = Number(match?.home_score);
  const awayScore = Number(match?.away_score);

  if (home === wanted) {
    return {
      goalsFor: homeScore,
      goalsAgainst: awayScore
    };
  }

  if (away === wanted) {
    return {
      goalsFor: awayScore,
      goalsAgainst: homeScore
    };
  }

  /*
   * Variante de nom : utiliser la correspondance forte pour
   * déterminer le côté du match.
   */
  const homeScoreMatch =
    calculateTeamMatchScore(team.name, match?.home || "");
  const awayScoreMatch =
    calculateTeamMatchScore(team.name, match?.away || "");

  if (homeScoreMatch > awayScoreMatch && homeScoreMatch > 0) {
    return {
      goalsFor: homeScore,
      goalsAgainst: awayScore
    };
  }

  if (awayScoreMatch > 0) {
    return {
      goalsFor: awayScore,
      goalsAgainst: homeScore
    };
  }

  return null;
}


// ============================================================
// STATISTIQUES
// ============================================================

function buildTeamStats(matches, team) {
  const selected = matches
    .filter(isFinished)
    .filter(hasRealScore)
    .filter(match => matchBelongsToTeam(match, team))
    .slice(0, TARGET_MATCHES);

  let goalsFor = 0;
  let goalsAgainst = 0;

  let homeMatches = 0;
  let homeGoalsFor = 0;
  let homeGoalsAgainst = 0;

  let awayMatches = 0;
  let awayGoalsFor = 0;
  let awayGoalsAgainst = 0;

  const teamName = cleanText(team.name);

  for (const match of selected) {
    const goals = getGoalsForAndAgainst(match, team);
    if (!goals) continue;

    goalsFor += goals.goalsFor;
    goalsAgainst += goals.goalsAgainst;

    const homeName = cleanText(match?.home);
    const awayName = cleanText(match?.away);

    if (homeName === teamName) {
      homeMatches += 1;
      homeGoalsFor += goals.goalsFor;
      homeGoalsAgainst += goals.goalsAgainst;
    } else if (awayName === teamName) {
      awayMatches += 1;
      awayGoalsFor += goals.goalsFor;
      awayGoalsAgainst += goals.goalsAgainst;
    } else {
      const homeScoreMatch =
        calculateTeamMatchScore(team.name, match?.home || "");
      const awayScoreMatch =
        calculateTeamMatchScore(team.name, match?.away || "");

      if (homeScoreMatch > awayScoreMatch && homeScoreMatch > 0) {
        homeMatches += 1;
        homeGoalsFor += goals.goalsFor;
        homeGoalsAgainst += goals.goalsAgainst;
      } else if (awayScoreMatch > 0) {
        awayMatches += 1;
        awayGoalsFor += goals.goalsFor;
        awayGoalsAgainst += goals.goalsAgainst;
      }
    }
  }

  return {
    matches: selected.length,
    goalsFor,
    goalsAgainst,
    homeMatches,
    homeGoalsFor,
    homeGoalsAgainst,
    awayMatches,
    awayGoalsFor,
    awayGoalsAgainst
  };
}


// ============================================================
// FORMAT POUR LE MOTEUR POISSON
// ============================================================

function buildEngineTeam(stats) {
  return {
    matches: stats.matches,
    goalsFor: stats.goalsFor,
    goalsAgainst: stats.goalsAgainst,
    homeMatches: stats.homeMatches,
    homeGoalsFor: stats.homeGoalsFor,
    homeGoalsAgainst: stats.homeGoalsAgainst,
    awayMatches: stats.awayMatches,
    awayGoalsFor: stats.awayGoalsFor,
    awayGoalsAgainst: stats.awayGoalsAgainst
  };
}


// ============================================================
// RISQUE INDICATIF
// ============================================================

function probabilityRisk(value) {
  const n = Number(value);

  if (n >= 60) return "Plus élevée";
  if (n >= 45) return "Intermédiaire";
  return "Plus incertaine";
}


// ============================================================
// CONSTRUCTION DU MODÈLE
// ============================================================

function buildModel(match, odds) {
  const probabilities = [
    {
      label: "1",
      value: odds.oneXTwo.home.probability
    },
    {
      label: "X",
      value: odds.oneXTwo.draw.probability
    },
    {
      label: "2",
      value: odds.oneXTwo.away.probability
    }
  ];

  const best = probabilities.reduce(
    (current, item) =>
      !current || Number(item.value) > Number(current.value)
        ? item
        : current,
    null
  );

  const options = [
    { name: "1", probability: odds.oneXTwo.home.probability },
    { name: "X", probability: odds.oneXTwo.draw.probability },
    { name: "2", probability: odds.oneXTwo.away.probability },
    { name: "Over 1.5", probability: odds.markets.over15.probability },
    { name: "Over 2.5", probability: odds.markets.over25.probability },
    { name: "Over 3.5", probability: odds.markets.over35.probability },
    { name: "Under 2.5", probability: odds.markets.under25.probability },
    { name: "Under 3.5", probability: odds.markets.under35.probability },
    { name: "BTTS Oui", probability: odds.markets.bttsYes.probability },
    { name: "BTTS Non", probability: odds.markets.bttsNo.probability }
  ].map(item => ({
    name: item.name,
    probability: item.probability,
    risk: probabilityRisk(item.probability),
    reason:
      "Probabilité calculée par le moteur Poisson v3 à partir des statistiques SportScore disponibles."
  }));

  return {
    ready: true,
    sufficientData: true,
    model: odds.model,
    recommendation: best?.label || "Analyse insuffisante",
    reason:
      `Le modèle calcule ${match.home} à domicile contre ${match.away} à partir des statistiques globales et du contexte domicile/extérieur disponibles.`,
    probabilities,
    options,
    expected_goals: odds.expectedGoals,
    most_likely_score: odds.mostLikelyScore,
    markets: odds.markets,
    context: odds.context,
    data_quality: "bonne"
  };
}


// ============================================================
// ANALYSE D'UNE AFFICHE
// ============================================================

async function analyzeOne(homeName, awayName) {
  const [homeTeam, awayTeam] = await Promise.all([
    searchTeam(homeName),
    searchTeam(awayName)
  ]);

  const [homeMatches, awayMatches] = await Promise.all([
    fetchTeamSchedule(homeTeam),
    fetchTeamSchedule(awayTeam)
  ]);

  if (homeMatches.length < MIN_MATCHES) {
    return {
      match: `${homeName} vs ${awayName}`,
      ready: false,
      recommendation: "Analyse insuffisante",
      reason:
        `${homeTeam.name}: seulement ${homeMatches.length} matchs historiques vérifiables.`,
      data_quality: "limitée",
      homeTeam: {
        name: homeTeam.name,
        slug: homeTeam.slug
      },
      awayTeam: {
        name: awayTeam.name,
        slug: awayTeam.slug
      },
      stats: {
        home: buildTeamStats(homeMatches, homeTeam),
        away: buildTeamStats(awayMatches, awayTeam)
      }
    };
  }

  if (awayMatches.length < MIN_MATCHES) {
    return {
      match: `${homeName} vs ${awayName}`,
      ready: false,
      recommendation: "Analyse insuffisante",
      reason:
        `${awayTeam.name}: seulement ${awayMatches.length} matchs historiques vérifiables.`,
      data_quality: "limitée",
      homeTeam: {
        name: homeTeam.name,
        slug: homeTeam.slug
      },
      awayTeam: {
        name: awayTeam.name,
        slug: awayTeam.slug
      },
      stats: {
        home: buildTeamStats(homeMatches, homeTeam),
        away: buildTeamStats(awayMatches, awayTeam)
      }
    };
  }

  const homeStats = buildTeamStats(homeMatches, homeTeam);
  const awayStats = buildTeamStats(awayMatches, awayTeam);

  const odds = calculateOdds({
    home: buildEngineTeam(homeStats),
    away: buildEngineTeam(awayStats)
  });

  if (!odds.sufficientData) {
    return {
      match: `${homeName} vs ${awayName}`,
      ready: false,
      recommendation: "Analyse insuffisante",
      reason:
        odds.reason || "Données statistiques insuffisantes.",
      data_quality: "limitée",
      homeTeam: {
        name: homeTeam.name,
        slug: homeTeam.slug
      },
      awayTeam: {
        name: awayTeam.name,
        slug: awayTeam.slug
      },
      stats: {
        home: homeStats,
        away: awayStats
      }
    };
  }

  const model = buildModel(
    {
      home: homeTeam.name,
      away: awayTeam.name
    },
    odds
  );

  return {
    match: `${homeTeam.name} vs ${awayTeam.name}`,
    homeTeam: {
      name: homeTeam.name,
      slug: homeTeam.slug
    },
    awayTeam: {
      name: awayTeam.name,
      slug: awayTeam.slug
    },
    stats: {
      home: homeStats,
      away: awayStats
    },
    odds,
    model
  };
}


// ============================================================
// ANALYSE DE 1 OU 2 MATCHS
// ============================================================

async function analyzeSportScoreMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) {
    throw new Error("Aucun match à analyser.");
  }

  const selected = matches
    .filter(item => item && item.home && item.away)
    .slice(0, 2);

  if (!selected.length) {
    throw new Error("Aucun match valide à analyser.");
  }

  const results = await Promise.all(
    selected.map(item =>
      analyzeOne(
        String(item.home).trim(),
        String(item.away).trim()
      )
    )
  );

  return {
    source: "SportScore",
    generatedAt: new Date().toISOString(),
    matches: results,
    models: results.map(result =>
      result.model || {
        ready: false,
        recommendation:
          result.recommendation || "Analyse insuffisante",
        reason:
          result.reason || "Données insuffisantes.",
        probabilities: [],
        options: [],
        data_quality:
          result.data_quality || "limitée"
      }
    )
  };
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  analyzeSportScoreMatches,
  searchTeam
};

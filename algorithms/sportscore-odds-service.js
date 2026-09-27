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
const MAX_LOOKBACK_DAYS = 730;
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
// ALIAS DES NOMS FRANÇAIS → NOMS SPORTScore
// ============================================================

const TEAM_NAME_ALIASES = {
  "cote d'ivoire": ["Cote d'Ivoire", "Ivory Coast"],
  "cote d ivoire": ["Cote d'Ivoire", "Ivory Coast"],
  "norvege": ["Norway"],
  "allemagne": ["Germany"],
  "angleterre": ["England"],
  "espagne": ["Spain"],
  "ecosse": ["Scotland"],
  "pays de galles": ["Wales"],
  "irlande": ["Ireland"],
  "irlande du nord": ["Northern Ireland"],
  "pays bas": ["Netherlands"],
  "belgique": ["Belgium"],
  "suisse": ["Switzerland"],
  "autriche": ["Austria"],
  "danemark": ["Denmark"],
  "suede": ["Sweden"],
  "finlande": ["Finland"],
  "islande": ["Iceland"],
  "grece": ["Greece"],
  "turquie": ["Turkey"],
  "croatie": ["Croatia"],
  "serbie": ["Serbia"],
  "slovenie": ["Slovenia"],
  "slovaquie": ["Slovakia"],
  "republique tcheque": ["Czech Republic", "Czechia"],
  "hongrie": ["Hungary"],
  "roumanie": ["Romania"],
  "bulgarie": ["Bulgaria"],
  "albanie": ["Albania"],
  "bosnie": ["Bosnia and Herzegovina"],
  "ukraine": ["Ukraine"],
  "russie": ["Russia"],
  "portugal": ["Portugal"],
  "italie": ["Italy"],
  "france": ["France"],
  "bresil": ["Brazil"],
  "argentine": ["Argentina"],
  "uruguay": ["Uruguay"],
  "chili": ["Chile"],
  "colombie": ["Colombia"],
  "equateur": ["Ecuador"],
  "mexique": ["Mexico"],
  "etats unis": ["United States"],
  "canada": ["Canada"],
  "japon": ["Japan"],
  "coree du sud": ["South Korea"],
  "australie": ["Australia"],
  "maroc": ["Morocco"],
  "algerie": ["Algeria"],
  "tunisie": ["Tunisia"],
  "egypte": ["Egypt"],
  "senegal": ["Senegal"],
  "cameroun": ["Cameroon"],
  "ghana": ["Ghana"],
  "nigeria": ["Nigeria"],
  "mali": ["Mali"],
  "burkina faso": ["Burkina Faso"],
  "guinee": ["Guinea"],
  "afrique du sud": ["South Africa"]
};

function getTeamSearchQueries(teamName) {
  const original = String(teamName || "").trim();
  const normalized = cleanText(original);
  const aliases = TEAM_NAME_ALIASES[normalized] || [];
  return Array.from(new Set([original, ...aliases].filter(Boolean)));
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
  const queries = getTeamSearchQueries(teamName);
  let lastSearchError = null;

  for (const query of queries) {
    try {
      const url =
        `${API_BASE}/search/` +
        `?q=${encodeURIComponent(query)}` +
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
        lastSearchError = new Error(
          `Aucune équipe trouvée pour "${query}".`
        );
        continue;
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

      if (ranked.length) {
        if (
          ranked.length === 1 ||
          ranked[0].score > ranked[1].score
        ) {
          return ranked[0].team;
        }
      }

      // Quand la requête utilisée est le nom canonique anglais,
      // une égalité exacte sur ce nom doit être prioritaire.
      const canonicalExact = teams.filter(
        team => cleanText(team.name) === cleanText(query)
      );

      if (canonicalExact.length === 1) return canonicalExact[0];
    } catch (error) {
      lastSearchError = error;
    }
  }

  throw new Error(
    lastSearchError?.message ||
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
  const homeScore = getMatchScore(match, "home");
  const awayScore = getMatchScore(match, "away");

  return (
    Number.isFinite(homeScore) &&
    Number.isFinite(awayScore) &&
    homeScore >= 0 &&
    awayScore >= 0
  );
}

function getMatchTeamName(match, side) {
  const direct = match?.[side];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    return direct.name || direct.team_name || direct.title || "";
  }

  const nested = match?.[`${side}_team`] || match?.[`${side}Team`] || match?.[`${side}_team_data`];
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object") {
    return nested.name || nested.team_name || nested.title || "";
  }

  const teams = match?.teams || match?.team_data || {};
  const team = teams?.[side];
  if (typeof team === "string") return team;
  if (team && typeof team === "object") {
    return team.name || team.team_name || team.title || "";
  }

  return "";
}

function getMatchScore(match, side) {
  const keys = side === "home"
    ? ["home_score", "homeScore"]
    : ["away_score", "awayScore"];

  for (const key of keys) {
    const value = match?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }

  const containers = [match?.score, match?.scores, match?.goals, match?.result];
  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    const value = container?.[side] ?? container?.fulltime?.[side] ?? container?.current?.[side];
    if (Number.isFinite(Number(value))) return Number(value);
  }

  return null;
}

function isFinished(match) {
  const status = cleanText(
    match?.status ||
    match?.status_text ||
    match?.statusText ||
    match?.state ||
    match?.fixture?.status?.short ||
    match?.fixture?.status?.long ||
    match?.event?.status ||
    ""
  );

  if (/cancel|postpon|scheduled|not started|upcoming|live|in progress|half time|halftime|suspend|abandon/.test(status)) {
    return false;
  }

  if (/finished|full time|fulltime|ended|completed|after extra time|aet|ft|final/.test(status)) {
    return true;
  }

  // Certains résultats historiques SportScore portent un score réel mais
  // pas de libellé d'état exploitable. Un score vérifiable + une date passée
  // est alors traité comme un match terminé.
  const timestamp = getMatchTimestamp(match);
  return hasRealScore(match) && timestamp > 0 && timestamp <= Date.now();
}

function matchBelongsToTeam(match, team) {
  const wanted = cleanText(team.name);
  const home = cleanText(getMatchTeamName(match, "home"));
  const away = cleanText(getMatchTeamName(match, "away"));

  if (home === wanted || away === wanted) return true;

  return (
    calculateTeamMatchScore(team.name, getMatchTeamName(match, "home")) > 0 ||
    calculateTeamMatchScore(team.name, getMatchTeamName(match, "away")) > 0
  );
}

function getMatchTimestamp(match) {
  const candidates = [
    match?.time,
    match?.start_time,
    match?.startTime,
    match?.datetime,
    match?.date,
    match?.fixture?.date,
    match?.fixture?.start_time,
    match?.fixture?.startTime,
    match?.event?.date,
    match?.event?.start_time
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

async function fetchHeadToHead(homeTeam, awayTeam) {
  const url =
    `${API_BASE}/h2h/` +
    `?sport=${SPORT}` +
    `&team1=${encodeURIComponent(homeTeam.slug)}` +
    `&team2=${encodeURIComponent(awayTeam.slug)}` +
    `&limit=20`;

  try {
    const data = await fetchJson(url);
    return extractMatches(data)
      .filter(hasRealScore)
      .filter(isFinished);
  } catch (_) {
    return [];
  }
}

function mergeUniqueMatches(primary, secondary) {
  const merged = [];
  const seen = new Set();

  for (const match of [...(primary || []), ...(secondary || [])]) {
    const key =
      match?.slug ||
      match?.url ||
      `${getMatchTeamName(match, "home")}|${getMatchTeamName(match, "away")}|${getMatchTimestamp(match)}`;

    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(match);
  }

  return merged;
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
  const home = getMatchTeamName(match, "home");
  const away = getMatchTeamName(match, "away");
  const homeScore = getMatchScore(match, "home");
  const awayScore = getMatchScore(match, "away");

  if (!home || !away || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    return null;
  }

  const wanted = cleanText(team.name);
  const homeKey = cleanText(home);
  const awayKey = cleanText(away);

  if (homeKey === wanted || calculateTeamMatchScore(team.name, home) > 0) {
    return { goalsFor: homeScore, goalsAgainst: awayScore };
  }

  if (awayKey === wanted || calculateTeamMatchScore(team.name, away) > 0) {
    return { goalsFor: awayScore, goalsAgainst: homeScore };
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

  let wins = 0;
  let draws = 0;
  let losses = 0;

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

    if (goals.goalsFor > goals.goalsAgainst) {
      wins += 1;
    } else if (goals.goalsFor === goals.goalsAgainst) {
      draws += 1;
    } else {
      losses += 1;
    }

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
    wins,
    draws,
    losses,
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

function normalizeOneXTwoPercentages(oneXTwo) {
  const raw = [
    Number(oneXTwo?.home?.probability),
    Number(oneXTwo?.draw?.probability),
    Number(oneXTwo?.away?.probability)
  ];

  if (!raw.every(Number.isFinite)) return null;

  const values = raw.map(value => value <= 1 ? value * 100 : value);
  const total = values.reduce((sum, value) => sum + value, 0);

  if (!(total > 0)) return null;

  return values.map(value =>
    Number(((value / total) * 100).toFixed(2))
  );
}

function buildModel(match, odds) {
  const normalized = normalizeOneXTwoPercentages(odds.oneXTwo);

  if (!normalized) {
    return {
      ready: false,
      sufficientData: false,
      recommendation: "Analyse insuffisante",
      reason: "Les probabilités 1X2 calculées sont invalides.",
      probabilities: [],
      options: [],
      data_quality: "limitée"
    };
  }

  const probabilities = [
    { label: "1", value: normalized[0] },
    { label: "X", value: normalized[1] },
    { label: "2", value: normalized[2] }
  ];

  const best = probabilities.reduce(
    (current, item) =>
      !current || Number(item.value) > Number(current.value)
        ? item
        : current,
    null
  );

  const options = [
    { name: "1", probability: normalized[0] },
    { name: "X", probability: normalized[1] },
    { name: "2", probability: normalized[2] },
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

  const [homeMatchesInitial, awayMatchesInitial, h2hMatches] = await Promise.all([
    fetchTeamSchedule(homeTeam),
    fetchTeamSchedule(awayTeam),
    fetchHeadToHead(homeTeam, awayTeam)
  ]);

  // Le H2H est un complément ciblé : il ne remplace pas l'historique
  // de chaque équipe, mais permet de récupérer des scores vérifiables
  // lorsque /team/ ou /fixtures/ ne renvoie pas assez de rencontres.
  const homeMatches = homeMatchesInitial.length < MIN_MATCHES
    ? mergeUniqueMatches(homeMatchesInitial, h2hMatches).sort((a,b) => getMatchTimestamp(b) - getMatchTimestamp(a)).slice(0, TARGET_MATCHES)
    : homeMatchesInitial;
  const awayMatches = awayMatchesInitial.length < MIN_MATCHES
    ? mergeUniqueMatches(awayMatchesInitial, h2hMatches).sort((a,b) => getMatchTimestamp(b) - getMatchTimestamp(a)).slice(0, TARGET_MATCHES)
    : awayMatchesInitial;

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

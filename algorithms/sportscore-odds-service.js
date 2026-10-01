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
const fixtureCache = new Map();
const FIXTURE_CACHE_TTL_MS = 30 * 1000;


// ============================================================
// TEXTE
// ============================================================

function cleanText(value) {
  /*
   * Normalisation robuste des noms d'équipes.
   *
   * Objectif : considérer comme équivalents les écritures suivantes :
   *   Paris-Saint-Germain
   *   Paris Saint Germain
   *   Paris–Saint–Germain
   *   Paris Saint-Germain
   * ainsi que les accents, apostrophes typographiques et autres
   * signes Unicode courants présents dans les noms officiels.
   */
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘ʻʼ`´]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/['-]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSignificantTokens(value) {
  const ignoredWords = new Set([
    "fc", "cf", "afc", "ac", "sc", "as", "rc",
    "fk", "sk", "nk", "ks", "bk", "kfc", "pfc",
    "cd", "cs", "rsc", "sv", "kv", "ka",
    "club", "football", "footballclub",
    "de", "du", "des", "the"
  ]);

  return cleanText(value)
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !ignoredWords.has(token));
}

// Alias des appellations françaises, anglaises et courantes.
// Ils servent uniquement à interroger SportScore avec plusieurs écritures
// possibles ; le nom canonique renvoyé par SportScore reste utilisé ensuite.
const TEAM_NAME_ALIASES = {
  "cote d'ivoire": ["Cote d'Ivoire", "Ivory Coast", "Côte d'Ivoire"],
  "cote d ivoire": ["Cote d'Ivoire", "Ivory Coast", "Côte d'Ivoire"],
  "ivory coast": ["Ivory Coast", "Cote d'Ivoire", "Côte d'Ivoire"],
  "allemagne": ["Germany"],
  "angleterre": ["England"],
  "espagne": ["Spain"],
  "ecosse": ["Scotland"],
  "pays de galles": ["Wales"],
  "irlande": ["Ireland", "Republic of Ireland"],
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
  "etats unis": ["United States", "USA"],
  "etats unis d amerique": ["United States", "USA"],
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
  "afrique du sud": ["South Africa"],

  // Clubs couramment saisis en français.
  "barcelone": ["Barcelona"],
  "fc barcelone": ["Barcelona", "FC Barcelona"],
  "paris saint germain": ["Paris Saint-Germain", "PSG"],
  "psg": ["Paris Saint-Germain", "PSG"],
  "olympique de marseille": ["Marseille", "Olympique de Marseille"],
  "om": ["Marseille", "Olympique de Marseille"],
  "olympique lyonnais": ["Lyon", "Olympique Lyonnais"],
  "lyon": ["Lyon", "Olympique Lyonnais"],
  "monaco": ["Monaco", "AS Monaco"],
  "lille": ["Lille", "Lille OSC"],
  "nice": ["Nice", "OGC Nice"],
  "rennes": ["Rennes", "Stade Rennais"],
  "nantes": ["Nantes", "FC Nantes"],
  "saint etienne": ["Saint-Etienne", "AS Saint-Etienne"]
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
        lastSearchError = new Error(`Aucune équipe trouvée pour "${query}".`);
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

      // Si la requête était un alias canonique anglais, une égalité exacte
      // sur cette requête reste prioritaire.
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

function getMatchSlug(match) {
  return String(
    match?.slug ||
    match?.fixture?.slug ||
    match?.event?.slug ||
    match?.url?.split("/match/").pop()?.replace(/\/$/, "") ||
    ""
  ).trim();
}

function getMatchStatusValue(match) {
  return (
    match?.status_text ||
    match?.statusText ||
    match?.status ||
    match?.status_code ||
    match?.state ||
    match?.fixture?.status?.long ||
    match?.fixture?.status?.short ||
    match?.event?.status ||
    ""
  );
}

function isLiveMatch(match) {
  const status = cleanText(getMatchStatusValue(match));
  return /live|in progress|progress|1h|2h|ht|half time|halftime|first half|second half|extra time|et|penalty|penalties|shootout/.test(status);
}

function normalizeFixture(match) {
  if (!match) return null;

  const home = getMatchTeamName(match, "home");
  const away = getMatchTeamName(match, "away");
  const timestamp = getMatchTimestamp(match);
  const homeScore = getMatchScore(match, "home");
  const awayScore = getMatchScore(match, "away");
  const competition =
    match?.league?.name ||
    match?.competition?.name ||
    (typeof match?.competition === "string" ? match.competition : "") ||
    match?.tournament?.name ||
    match?.fixture?.league?.name ||
    "Compétition non fournie";

  return {
    id: String(match?.id || match?.fixture?.id || match?.event?.id || ""),
    slug: getMatchSlug(match),
    home,
    away,
    date: timestamp ? new Date(timestamp).toISOString() : null,
    status: getMatchStatusValue(match) || (timestamp > Date.now() ? "upcoming" : ""),
    status_text: match?.status_text || match?.statusText || null,
    competition,
    goals: {
      home: Number.isFinite(homeScore) ? homeScore : null,
      away: Number.isFinite(awayScore) ? awayScore : null
    },
    score: match?.score || match?.scores || null,
    home_logo: match?.home_logo || match?.home?.logo || null,
    away_logo: match?.away_logo || match?.away?.logo || null
  };
}

function fixtureMatchesTeams(match, homeTeam, awayTeam) {
  const fixture = normalizeFixture(match);
  if (!fixture?.home || !fixture?.away) return false;

  return (
    cleanText(fixture.home) === cleanText(homeTeam.name) &&
    cleanText(fixture.away) === cleanText(awayTeam.name)
  ) || (
    calculateTeamMatchScore(homeTeam.name, fixture.home) > 0 &&
    calculateTeamMatchScore(awayTeam.name, fixture.away) > 0
  );
}

async function fetchFixtureDetail(slug) {
  if (!slug) return null;

  try {
    const data = await fetchJson(
      `${API_BASE}/match/?sport=${SPORT}&slug=${encodeURIComponent(slug)}`
    );

    return (
      data?.match ||
      data?.fixture ||
      data?.event ||
      data?.data?.match ||
      data?.data?.fixture ||
      data?.data?.event ||
      data?.data ||
      data
    );
  } catch (_) {
    return null;
  }
}

async function fetchCurrentFixture(homeTeam, awayTeam) {
  const cacheKey = `${cleanText(homeTeam.slug)}|${cleanText(awayTeam.slug)}`;
  const cached = fixtureCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.fixture;
  }

  const candidates = [];
  const today = formatUtcDate(new Date());

  // 1. Priorité aux rencontres du jour : direct et à venir.
  const fixtureQueries = [];

  // Aujourd'hui : matchs en direct et à venir.
  fixtureQueries.push(
    [homeTeam.slug, "live", today],
    [homeTeam.slug, "upcoming", today],
    [awayTeam.slug, "live", today],
    [awayTeam.slug, "upcoming", today]
  );

  // Prochains 3 jours : uniquement les matchs à venir.
  for (let daysAhead = 1; daysAhead <= 3; daysAhead++) {
    const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    const dateText = formatUtcDate(date);

    fixtureQueries.push(
      [homeTeam.slug, "upcoming", dateText],
      [awayTeam.slug, "upcoming", dateText]
    );
  }

  const todayResponses = await Promise.allSettled(
    fixtureQueries.map(([teamSlug, status, dateText]) => {
      const url =
        `${API_BASE}/fixtures/` +
        `?sport=${SPORT}` +
        `&date=${dateText}` +
        `&status=${status}` +
        `&team=${encodeURIComponent(teamSlug)}` +
        `&limit=200`;
      return fetchJson(url);
    })
  );

  for (const response of todayResponses) {
    if (response.status !== "fulfilled") continue;
    for (const match of extractMatches(response.value)) {
      if (fixtureMatchesTeams(match, homeTeam, awayTeam)) {
        candidates.push(match);
      }
    }
  }

  // 2. Le calendrier des deux équipes contient les rencontres passées
  //    ET à venir. Il sert à vérifier qu'une affiche saisie existe réellement.
  const teamResponses = await Promise.allSettled([
    fetchJson(`${API_BASE}/team/?sport=${SPORT}&slug=${encodeURIComponent(homeTeam.slug)}&limit=${TEAM_ENDPOINT_LIMIT}`),
    fetchJson(`${API_BASE}/team/?sport=${SPORT}&slug=${encodeURIComponent(awayTeam.slug)}&limit=${TEAM_ENDPOINT_LIMIT}`)
  ]);

  for (const response of teamResponses) {
    if (response.status !== "fulfilled") continue;
    for (const match of extractMatches(response.value)) {
      if (fixtureMatchesTeams(match, homeTeam, awayTeam)) {
        candidates.push(match);
      }
    }
  }

  // 3. Pour les confrontations historiques, le H2H est la dernière
  //    vérification ciblée. On ne l'utilise jamais pour inventer un match.
  try {
    const h2hData = await fetchJson(
      `${API_BASE}/h2h/?sport=${SPORT}` +
      `&team1=${encodeURIComponent(homeTeam.slug)}` +
      `&team2=${encodeURIComponent(awayTeam.slug)}` +
      `&limit=50`
    );
    for (const match of extractMatches(h2hData)) {
      if (fixtureMatchesTeams(match, homeTeam, awayTeam)) {
        candidates.push(match);
      }
    }
  } catch (_) {
    // L'absence du H2H ne doit pas empêcher les vérifications
    // déjà obtenues par /fixtures/ et /team/.
  }

  if (!candidates.length) {
    fixtureCache.set(cacheKey, {
      fixture: null,
      expiresAt: Date.now() + FIXTURE_CACHE_TTL_MS
    });
    return null;
  }

  const unique = new Map();
  for (const match of candidates) {
    const normalized = normalizeFixture(match);
    if (!normalized?.home || !normalized?.away) continue;

    const key =
      normalized.id ||
      normalized.slug ||
      `${cleanText(normalized.home)}|${cleanText(normalized.away)}|${normalized.date || ""}`;

    unique.set(key, match);
  }

  if (!unique.size) {
    fixtureCache.set(cacheKey, {
      fixture: null,
      expiresAt: Date.now() + FIXTURE_CACHE_TTL_MS
    });
    return null;
  }

  // Priorité : direct > à venir > rencontre terminée la plus récente.
  const ordered = [...unique.values()].filter(match => !isFinished(match)).sort((a, b) => {
    const liveDiff = Number(isLiveMatch(b)) - Number(isLiveMatch(a));
    if (liveDiff) return liveDiff;

    const ta = getMatchTimestamp(a);
    const tb = getMatchTimestamp(b);
    const now = Date.now();
    const aUpcoming = ta > now;
    const bUpcoming = tb > now;

    if (aUpcoming !== bUpcoming) return Number(bUpcoming) - Number(aUpcoming);
    if (aUpcoming && bUpcoming) return ta - tb;
    return tb - ta;
  });

  if (!ordered.length) {
    fixtureCache.set(cacheKey, {
      fixture: null,
      expiresAt: Date.now() + FIXTURE_CACHE_TTL_MS
    });
    return null;
  }

  let fixture = normalizeFixture(ordered[0]);
  const detail = await fetchFixtureDetail(fixture?.slug);

  if (detail && fixtureMatchesTeams(detail, homeTeam, awayTeam)) {
    fixture = normalizeFixture({ ...ordered[0], ...detail });
  }

  fixtureCache.set(cacheKey, {
    fixture,
    expiresAt: Date.now() + FIXTURE_CACHE_TTL_MS
  });

  return fixture;
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

  const [homeMatchesInitial, awayMatchesInitial, h2hMatches, fixture] = await Promise.all([
    fetchTeamSchedule(homeTeam),
    fetchTeamSchedule(awayTeam),
    fetchHeadToHead(homeTeam, awayTeam),
    fetchCurrentFixture(homeTeam, awayTeam)
  ]);

  // Règle fondamentale : une affiche saisie manuellement doit d'abord
  // être vérifiée comme rencontre réelle dans SportScore. Sans fixture
  // correspondante, aucune statistique ni probabilité ne doit être produite.
  if (!fixture) {
    return {
      match: `${homeName} vs ${awayName}`,
      fixture: null,
      ready: false,
      recommendation: "Match non vérifié",
      reason:
        "Cette rencontre n’a pas été retrouvée dans les données réelles SportScore. Aucune analyse statistique n’est produite.",
      data_quality: "non vérifiée",
      homeTeam: {
        name: homeTeam.name,
        slug: homeTeam.slug
      },
      awayTeam: {
        name: awayTeam.name,
        slug: awayTeam.slug
      },
      stats: {
        home: buildTeamStats(homeMatchesInitial, homeTeam),
        away: buildTeamStats(awayMatchesInitial, awayTeam)
      }
    };
  }

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
      fixture,
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
      fixture,
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
      fixture,
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
    fixture,
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
// EXTRACTION ET RESOLUTION D'UNE AFFICHE
// ============================================================

function splitExplicitMatch(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  // Séparateurs explicites. Un tiret n'est séparateur que lorsqu'il est
  // entouré d'espaces afin de ne pas casser Paris-Saint-Germain.
  const separator = /\s*(?:versus|vs|contre)\s*|\s+v\s+|\s*[\/|]\s*|\s+[-–—−]\s+/i;
  const parts = text.split(separator).map(part => part.trim()).filter(Boolean);

  if (parts.length < 2) return null;

  return {
    home: parts[0],
    away: parts.slice(1).join(" ")
  };
}

function buildSplitCandidates(value) {
  const text = String(value || "").trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];

  const indexes = Array.from(
    { length: tokens.length - 1 },
    (_, index) => index + 1
  ).sort((a, b) => {
    const middle = tokens.length / 2;
    return Math.abs(a - middle) - Math.abs(b - middle);
  });

  return indexes.map(index => ({
    home: tokens.slice(0, index).join(" "),
    away: tokens.slice(index).join(" ")
  }));
}

async function resolveUnseparatedMatch(value) {
  const candidates = buildSplitCandidates(value);
  if (!candidates.length) {
    throw new Error(`Format de match invalide : "${value}".`);
  }

  const attempts = [];

  for (const candidate of candidates) {
    const [homeResult, awayResult] = await Promise.allSettled([
      searchTeam(candidate.home),
      searchTeam(candidate.away)
    ]);

    if (homeResult.status !== "fulfilled" || awayResult.status !== "fulfilled") {
      continue;
    }

    const homeTeam = homeResult.value;
    const awayTeam = awayResult.value;
    const homeScore = calculateTeamMatchScore(candidate.home, homeTeam.name);
    const awayScore = calculateTeamMatchScore(candidate.away, awayTeam.name);

    if (homeScore <= 0 || awayScore <= 0) continue;

    attempts.push({
      ...candidate,
      homeTeam,
      awayTeam,
      score: homeScore + awayScore
    });

    if (homeScore === 1000 && awayScore === 1000) {
      return {
        home: candidate.home,
        away: candidate.away
      };
    }
  }

  if (!attempts.length) {
    throw new Error(
      `Impossible d'identifier les deux équipes dans "${value}".`
    );
  }

  attempts.sort((a, b) => b.score - a.score);

  return {
    home: attempts[0].home,
    away: attempts[0].away
  };
}

async function normalizeMatchInput(item) {
  if (!item || typeof item !== "object") {
    throw new Error("Match invalide.");
  }

  if (item.home && item.away) {
    return {
      home: String(item.home).trim(),
      away: String(item.away).trim()
    };
  }

  const raw =
    item.match ||
    item.text ||
    item.input ||
    item.fixture ||
    item.name ||
    "";

  const explicit = splitExplicitMatch(raw);
  if (explicit) return explicit;

  return resolveUnseparatedMatch(raw);
}


// ============================================================
// ANALYSE DE 1 OU 2 MATCHS
// ============================================================

async function analyzeSportScoreMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) {
    throw new Error("Aucun match à analyser.");
  }

  const selected = matches.slice(0, 2);
  const normalized = await Promise.all(selected.map(normalizeMatchInput));

  if (!normalized.length) {
    throw new Error("Aucun match valide à analyser.");
  }

  const results = await Promise.all(
    normalized.map(item =>
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
  searchTeam,
  cleanText,
  calculateTeamMatchScore
};

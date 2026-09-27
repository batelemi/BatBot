/**
 * BATBOT — TEST MULTI-MATCHS
 *
 * Vérifie le moteur Poisson v3 sur plusieurs affiches
 * afin de contrôler que les statistiques domicile/extérieur
 * fonctionnent correctement sur différents matchs.
 */

"use strict";

const {
  calculateOdds
} = require("./odds-engine");

const SPORT = "football";

const API_BASE =
  "https://sportscore.com/api/v1";

const MIN_MATCHES = 5;
const MIN_SPLIT_MATCHES = 3;

const MATCHES = [
  {
    home: "Real Madrid",
    away: "FC Barcelona"
  },
  {
    home: "Bayern Munich",
    away: "Borussia Dortmund"
  },
  {
    home: "Paris Saint Germain",
    away: "Marseille"
  }
];


// ============================================================
// OUTILS
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
    "fc",
    "cf",
    "afc",
    "ac",
    "sc",
    "as",
    "rc",
    "fk",
    "sk",
    "de",
    "du",
    "des",
    "the"
  ]);

  return cleanText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      token =>
        !ignoredWords.has(token)
    );
}


function calculateTeamMatchScore(
  wantedName,
  candidateName
) {
  const wanted =
    cleanText(wantedName);

  const candidate =
    cleanText(candidateName);

  /*
   * Correspondance exacte.
   */
  if (candidate === wanted) {
    return 1000;
  }

  const wantedTokens =
    getSignificantTokens(
      wantedName
    );

  const candidateTokens =
    getSignificantTokens(
      candidateName
    );

  if (
    wantedTokens.length === 0 ||
    candidateTokens.length === 0
  ) {
    return 0;
  }

  const wantedSet =
    new Set(wantedTokens);

  const candidateSet =
    new Set(candidateTokens);

  /*
   * Tous les mots importants recherchés
   * doivent être présents dans le candidat.
   */
  const containsAllWanted =
    wantedTokens.every(
      token =>
        candidateSet.has(token)
    );

  if (!containsAllWanted) {
    return 0;
  }

  /*
   * On évite les équipes dérivées :
   * Women, II, U19, Legends, etc.
   */
  const forbiddenVariants = new Set([
    "women",
    "woman",
    "ladies",
    "girls",
    "youth",
    "u19",
    "u20",
    "u21",
    "u23",
    "ii",
    "iii",
    "legends",
    "indoor",
    "academy",
    "reserves",
    "reserve",
    "b"
  ]);

  const hasForbiddenVariant =
    candidateTokens.some(
      token =>
        forbiddenVariants.has(token)
    );

  if (hasForbiddenVariant) {
    return 0;
  }

  /*
   * Plus le nombre de mots supplémentaires est faible,
   * plus le candidat est probablement l'équipe recherchée.
   */
  const extraTokens =
    candidateTokens.filter(
      token =>
        !wantedSet.has(token)
    );

  let score = 500;

  score -=
    extraTokens.length * 40;

  /*
   * Bonus lorsque le nom candidat commence
   * ou finit simplement par FC / CF / AFC.
   */
  const normalizedCandidate =
    cleanText(candidateName);

  if (
    normalizedCandidate.startsWith(
      `${wanted} fc`
    ) ||
    normalizedCandidate.endsWith(
      ` ${wanted} fc`
    ) ||
    normalizedCandidate.startsWith(
      `fc ${wanted}`
    ) ||
    normalizedCandidate.startsWith(
      `cf ${wanted}`
    ) ||
    normalizedCandidate.startsWith(
      `afc ${wanted}`
    )
  ) {
    score += 100;
  }

  return Math.max(
    score,
    1
  );
}


async function fetchJson(url) {
  const response =
    await fetch(url, {
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

  const data =
    await fetchJson(url);

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

  for (
    const candidate of candidates
  ) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (
      const team of candidate
    ) {
      const name =
        team?.name ||
        team?.team?.name ||
        "";

      const slug =
        team?.slug ||
        team?.team?.slug ||
        "";

      if (!name || !slug) {
        continue;
      }

      const key =
        `${cleanText(name)}|${cleanText(slug)}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      teams.push({
        ...team,
        name,
        slug
      });
    }
  }

  if (teams.length === 0) {
    throw new Error(
      `Aucune équipe trouvée pour "${teamName}".`
    );
  }

  /*
   * 1. On cherche d'abord une correspondance exacte.
   */
  const wanted =
    cleanText(teamName);

  const exact =
    teams.filter(
      team =>
        cleanText(team.name) ===
        wanted
    );

  if (exact.length === 1) {
    return exact[0];
  }

  if (exact.length > 1) {
    throw new Error(
      `Plusieurs équipes correspondent exactement à "${teamName}".`
    );
  }

  /*
   * 2. Si aucune correspondance exacte,
   * on utilise le système de score.
   */
  const ranked =
    teams
      .map(team => ({
        team,
        score:
          calculateTeamMatchScore(
            teamName,
            team.name
          )
      }))
      .filter(
        item =>
          item.score > 0
      )
      .sort(
        (a, b) =>
          b.score - a.score
      );

  if (ranked.length === 1) {
    console.log(
      `\n🔎 Correspondance intelligente : ` +
      `"${teamName}" → "${ranked[0].team.name}"`
    );

    return ranked[0].team;
  }

  if (
    ranked.length > 1 &&
    ranked[0].score >
      ranked[1].score
  ) {
    console.log(
      `\n🔎 Correspondance intelligente : ` +
      `"${teamName}" → "${ranked[0].team.name}"`
    );

    return ranked[0].team;
  }

  /*
   * Diagnostic si aucune correspondance suffisamment fiable.
   */
  console.log(
    `\n🔎 Résultats disponibles pour "${teamName}" :`
  );

  for (
    const team of teams.slice(0, 20)
  ) {
    console.log(
      `   • ${team.name} → ${team.slug}`
    );
  }

  throw new Error(
    `Impossible d'identifier précisément "${teamName}".`
  );
}


// ============================================================
// EXTRACTION MATCHS
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

  for (
    const candidate of candidates
  ) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}


// ============================================================
// DATES
// ============================================================

function formatUtcDate(date) {
  return date
    .toISOString()
    .slice(0, 10);
}


function subtractUtcDays(
  date,
  days
) {
  const copy =
    new Date(date);

  copy.setUTCDate(
    copy.getUTCDate() - days
  );

  return copy;
}


// ============================================================
// VALIDATION MATCH
// ============================================================

function hasRealScore(match) {
  const homeScore =
    match?.home_score;

  const awayScore =
    match?.away_score;

  return (
    homeScore !== null &&
    homeScore !== undefined &&
    awayScore !== null &&
    awayScore !== undefined &&
    Number.isFinite(
      Number(homeScore)
    ) &&
    Number.isFinite(
      Number(awayScore)
    ) &&
    Number(homeScore) >= 0 &&
    Number(awayScore) >= 0
  );
}


function isFinished(match) {
  return (
    cleanText(match?.status) ===
    "finished"
  );
}


function matchBelongsToTeam(
  match,
  team
) {
  const wanted =
    cleanText(team.name);

  return (
    cleanText(match?.home) ===
      wanted ||
    cleanText(match?.away) ===
      wanted
  );
}


// ============================================================
// HISTORIQUE
// ============================================================

async function fetchTeamSchedule(
  team
) {
  const collected = [];
  const seen = new Set();

  const MAX_LOOKBACK_DAYS = 180;
  const TARGET_MATCHES = 10;

  const today =
    new Date();

  for (
    let daysAgo = 0;
    daysAgo < MAX_LOOKBACK_DAYS;
    daysAgo++
  ) {
    const date =
      subtractUtcDays(
        today,
        daysAgo
      );

    const dateText =
      formatUtcDate(date);

    const url =
      `${API_BASE}/fixtures/` +
      `?sport=${SPORT}` +
      `&date=${dateText}` +
      `&status=finished` +
      `&team=${encodeURIComponent(team.slug)}` +
      `&limit=200`;

    try {
      const data =
        await fetchJson(url);

      const matches =
        extractMatches(data);

      for (
        const match of matches
      ) {
        if (!hasRealScore(match)) {
          continue;
        }

        if (!isFinished(match)) {
          continue;
        }

        if (
          !matchBelongsToTeam(
            match,
            team
          )
        ) {
          continue;
        }

        const key =
          match?.url ||
          `${match?.home}|${match?.away}|${match?.time}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);

        collected.push(match);
      }

      if (
        collected.length >=
        TARGET_MATCHES
      ) {
        break;
      }
    } catch (error) {
      console.log(
        `⚠️ ${team.name} — ${dateText}: ${error.message}`
      );
    }
  }

  return collected
    .sort((a, b) => {
      const dateA =
        new Date(
          a?.time || 0
        ).getTime();

      const dateB =
        new Date(
          b?.time || 0
        ).getTime();

      return dateB - dateA;
    })
    .slice(
      0,
      TARGET_MATCHES
    );
}


// ============================================================
// BUTS
// ============================================================

function getGoalsForAndAgainst(
  match,
  team
) {
  const home =
    cleanText(match?.home);

  const away =
    cleanText(match?.away);

  const wanted =
    cleanText(team.name);

  const homeScore =
    Number(match?.home_score);

  const awayScore =
    Number(match?.away_score);

  if (
    home === wanted
  ) {
    return {
      goalsFor: homeScore,
      goalsAgainst: awayScore
    };
  }

  if (
    away === wanted
  ) {
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

function buildTeamStats(
  matches,
  team
) {
  const selected =
    matches
      .filter(isFinished)
      .filter(hasRealScore)
      .filter(match =>
        matchBelongsToTeam(
          match,
          team
        )
      )
      .slice(0, 10);

  let goalsFor = 0;
  let goalsAgainst = 0;

  let homeMatches = 0;
  let homeGoalsFor = 0;
  let homeGoalsAgainst = 0;

  let awayMatches = 0;
  let awayGoalsFor = 0;
  let awayGoalsAgainst = 0;

  const teamName =
    cleanText(team.name);

  for (
    const match of selected
  ) {
    const goals =
      getGoalsForAndAgainst(
        match,
        team
      );

    if (!goals) {
      continue;
    }

    goalsFor +=
      goals.goalsFor;

    goalsAgainst +=
      goals.goalsAgainst;

    const homeName =
      cleanText(match?.home);

    const awayName =
      cleanText(match?.away);

    if (
      homeName ===
      teamName
    ) {
      homeMatches += 1;

      homeGoalsFor +=
        goals.goalsFor;

      homeGoalsAgainst +=
        goals.goalsAgainst;
    }

    if (
      awayName ===
      teamName
    ) {
      awayMatches += 1;

      awayGoalsFor +=
        goals.goalsFor;

      awayGoalsAgainst +=
        goals.goalsAgainst;
    }
  }

  return {
    matches:
      selected.length,

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
// CONSTRUCTION DU INPUT MOTEUR
// ============================================================

function buildEngineTeam(
  stats
) {
  return {
    matches:
      stats.matches,

    goalsFor:
      stats.goalsFor,

    goalsAgainst:
      stats.goalsAgainst,

    homeMatches:
      stats.homeMatches,

    homeGoalsFor:
      stats.homeGoalsFor,

    homeGoalsAgainst:
      stats.homeGoalsAgainst,

    awayMatches:
      stats.awayMatches,

    awayGoalsFor:
      stats.awayGoalsFor,

    awayGoalsAgainst:
      stats.awayGoalsAgainst
  };
}


// ============================================================
// TEST D'UNE AFFICHE
// ============================================================

async function testMatch(
  matchDefinition,
  index
) {
  console.log(
    "\n\n========================================"
  );

  console.log(
    ` TEST ${index} / ${MATCHES.length}`
  );

  console.log(
    ` ${matchDefinition.home} vs ${matchDefinition.away}`
  );

  console.log(
    "========================================"
  );

  const homeTeam =
    await searchTeam(
      matchDefinition.home
    );

  const awayTeam =
    await searchTeam(
      matchDefinition.away
    );

  console.log(
    `\n🏠 ${homeTeam.name} → ${homeTeam.slug}`
  );

  console.log(
    `✈️ ${awayTeam.name} → ${awayTeam.slug}`
  );

  const homeMatches =
    await fetchTeamSchedule(
      homeTeam
    );

  const awayMatches =
    await fetchTeamSchedule(
      awayTeam
    );

  if (
    homeMatches.length <
    MIN_MATCHES
  ) {
    throw new Error(
      `${homeTeam.name}: seulement ${homeMatches.length} matchs historiques.`
    );
  }

  if (
    awayMatches.length <
    MIN_MATCHES
  ) {
    throw new Error(
      `${awayTeam.name}: seulement ${awayMatches.length} matchs historiques.`
    );
  }

  const homeStats =
    buildTeamStats(
      homeMatches,
      homeTeam
    );

  const awayStats =
    buildTeamStats(
      awayMatches,
      awayTeam
    );

  console.log(
    "\n📊 STATISTIQUES"
  );

  console.log(
    `   ${homeTeam.name} : ` +
    `${homeStats.matches} matchs`
  );

  console.log(
    `      🏠 domicile : ${homeStats.homeMatches}`
  );

  console.log(
    `      ✈️ extérieur : ${homeStats.awayMatches}`
  );

  console.log(
    `   ${awayTeam.name} : ` +
    `${awayStats.matches} matchs`
  );

  console.log(
    `      🏠 domicile : ${awayStats.homeMatches}`
  );

  console.log(
    `      ✈️ extérieur : ${awayStats.awayMatches}`
  );

  const result =
    calculateOdds({
      home:
        buildEngineTeam(
          homeStats
        ),

      away:
        buildEngineTeam(
          awayStats
        )
    });

  if (
    !result.sufficientData
  ) {
    throw new Error(
      result.reason
    );
  }

  console.log(
    "\n🧠 CONTEXTE UTILISÉ"
  );

  console.log(
    `   ${homeTeam.name} : ` +
    `${result.context.home.source} ` +
    `(${result.context.home.contextualMatches} matchs contextuels)`
  );

  console.log(
    `   ${awayTeam.name} : ` +
    `${result.context.away.source} ` +
    `(${result.context.away.contextualMatches} matchs contextuels)`
  );

  console.log(
    "\n⚽ BUTS ATTENDUS"
  );

  console.log(
    `   ${homeTeam.name} : ${result.expectedGoals.home}`
  );

  console.log(
    `   ${awayTeam.name} : ${result.expectedGoals.away}`
  );

  console.log(
    "\n📈 1X2"
  );

  console.log(
    `   1 : ${result.oneXTwo.home.probability}%`
  );

  console.log(
    `   X : ${result.oneXTwo.draw.probability}%`
  );

  console.log(
    `   2 : ${result.oneXTwo.away.probability}%`
  );

  const total =
    result.oneXTwo.home.probability +
    result.oneXTwo.draw.probability +
    result.oneXTwo.away.probability;

  console.log(
    `   Total : ${total.toFixed(2)}%`
  );

  if (
    Math.abs(total - 100) >=
    0.01
  ) {
    throw new Error(
      "Le total 1X2 n'est pas égal à 100 %."
    );
  }

  console.log(
    "\n🎯 SCORE LE PLUS PROBABLE"
  );

  console.log(
    `   ${result.mostLikelyScore.score} → ` +
    `${result.mostLikelyScore.probability}%`
  );

  console.log(
    "\n📊 MARCHÉS"
  );

  console.log(
    `   Over 2.5 : ${result.markets.over25.probability}%`
  );

  console.log(
    `   Under 2.5 : ${result.markets.under25.probability}%`
  );

  console.log(
    `   BTTS Oui : ${result.markets.bttsYes.probability}%`
  );

  console.log(
    `   BTTS Non : ${result.markets.bttsNo.probability}%`
  );

  console.log(
    "\n✅ TEST DE L'AFFICHE RÉUSSI"
  );

  return {
    home:
      homeTeam.name,

    away:
      awayTeam.name,

    expectedGoals:
      result.expectedGoals,

    oneXTwo:
      result.oneXTwo,

    mostLikelyScore:
      result.mostLikelyScore
  };
}


// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================

async function main() {
  console.log(
    "========================================"
  );

  console.log(
    " BATBOT — TEST MULTI-MATCHS"
  );

  console.log(
    " POISSON V3 HOME/AWAY"
  );

  console.log(
    "========================================"
  );

  const results = [];

  for (
    let i = 0;
    i < MATCHES.length;
    i += 1
  ) {
    try {
      const result =
        await testMatch(
          MATCHES[i],
          i + 1
        );

      results.push(
        result
      );
    } catch (error) {
      console.error(
        `\n❌ ÉCHEC DU TEST ${i + 1}`
      );

      console.error(
        error.message
      );

      process.exit(1);
    }
  }

  console.log(
    "\n\n========================================"
  );

  console.log(
    " 📋 RÉSUMÉ MULTI-MATCHS"
  );

  console.log(
    "========================================"
  );

  for (
    const result of results
  ) {
    console.log(
      `\n⚽ ${result.home} vs ${result.away}`
    );

    console.log(
      `   1 : ${result.oneXTwo.home.probability}%`
    );

    console.log(
      `   X : ${result.oneXTwo.draw.probability}%`
    );

    console.log(
      `   2 : ${result.oneXTwo.away.probability}%`
    );

    console.log(
      `   Score : ${result.mostLikelyScore.score}`
    );
  }

  console.log(
    "\n========================================"
  );

  console.log(
    " ✅ TOUS LES TESTS MULTI-MATCHS SONT RÉUSSIS"
  );

  console.log(
    "========================================"
  );
}


main().catch(error => {
  console.error(
    "\n❌ ERREUR FATALE"
  );

  console.error(
    error.message
  );

  process.exit(1);
});

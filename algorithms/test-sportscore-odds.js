/**
 * BATBOT — SPORTScore → MOTEUR DE COTES
 *
 * Test réel du moteur statistique.
 *
 * Récupère les derniers matchs terminés depuis SportScore,
 * calcule les statistiques générales + domicile/extérieur,
 * puis transmet les données au moteur Poisson.
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

const HOME_TEAM_NAME =
  process.argv[2] || "Real Madrid";

const AWAY_TEAM_NAME =
  process.argv[3] || "FC Barcelona";


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


// ============================================================
// API SPORTScore
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
// RECHERCHE DES ÉQUIPES
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

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const team of candidate) {
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

  console.log(
    `\n🔎 Recherche : "${teamName}"`
  );

  for (const team of teams) {
    console.log(
      `   • ${team.name} → ${team.slug}`
    );
  }

  const wanted =
    cleanText(teamName);

  const exact =
    teams.filter(
      team =>
        cleanText(team.name) === wanted
    );

  if (exact.length === 1) {
    return exact[0];
  }

  if (exact.length > 1) {
    throw new Error(
      `Plusieurs équipes correspondent exactement à "${teamName}".`
    );
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


function subtractUtcDays(date, days) {
  const copy =
    new Date(date);

  copy.setUTCDate(
    copy.getUTCDate() - days
  );

  return copy;
}


// ============================================================
// CALENDRIER HISTORIQUE
// ============================================================

async function fetchTeamSchedule(team) {
  const collected = [];
  const seen = new Set();

  const MAX_LOOKBACK_DAYS = 180;
  const TARGET_MATCHES = 10;

  const today =
    new Date();

  console.log(
    `\n📅 Recherche des matchs historiques de ${team.name}...`
  );

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

      for (const match of matches) {
        if (!hasRealScore(match)) {
          continue;
        }

        if (!matchBelongsToTeam(match, team)) {
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

  const sorted =
    collected.sort((a, b) => {
      const dateA =
        new Date(a?.time || 0).getTime();

      const dateB =
        new Date(b?.time || 0).getTime();

      return dateB - dateA;
    });

  console.log(
    `✅ ${team.name}: ${sorted.length} matchs historiques trouvés`
  );

  return sorted.slice(
    0,
    TARGET_MATCHES
  );
}


// ============================================================
// VALIDATION DES MATCHS
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
    cleanText(match?.home) === wanted ||
    cleanText(match?.away) === wanted
  );
}


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

  return null;
}


// ============================================================
// CONSTRUCTION DES STATISTIQUES
// ============================================================

function buildTeamStats(
  matches,
  team
) {
  const finished =
    matches
      .filter(isFinished)
      .filter(hasRealScore)
      .filter(match =>
        matchBelongsToTeam(
          match,
          team
        )
      )
      .sort((a, b) => {
        const dateA =
          new Date(a?.time || 0).getTime();

        const dateB =
          new Date(b?.time || 0).getTime();

        return dateB - dateA;
      });

  const selected =
    finished.slice(0, 10);

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

  for (const match of selected) {
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
      homeName === teamName
    ) {
      homeMatches += 1;

      homeGoalsFor +=
        goals.goalsFor;

      homeGoalsAgainst +=
        goals.goalsAgainst;
    }

    if (
      awayName === teamName
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

    averageGoalsFor:
      selected.length
        ? goalsFor / selected.length
        : 0,

    averageGoalsAgainst:
      selected.length
        ? goalsAgainst / selected.length
        : 0,

    homeMatches,

    homeGoalsFor,

    homeGoalsAgainst,

    homeAverageGoalsFor:
      homeMatches
        ? homeGoalsFor / homeMatches
        : 0,

    homeAverageGoalsAgainst:
      homeMatches
        ? homeGoalsAgainst / homeMatches
        : 0,

    awayMatches,

    awayGoalsFor,

    awayGoalsAgainst,

    awayAverageGoalsFor:
      awayMatches
        ? awayGoalsFor / awayMatches
        : 0,

    awayAverageGoalsAgainst:
      awayMatches
        ? awayGoalsAgainst / awayMatches
        : 0,

    recentMatches:
      selected
  };
}


// ============================================================
// AFFICHAGE DES STATISTIQUES
// ============================================================

function printTeamStats(
  team,
  stats
) {
  console.log(
    `\n📊 ${team.name}`
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `Matchs analysés        : ${stats.matches}`
  );

  console.log(
    `Buts marqués           : ${stats.goalsFor}`
  );

  console.log(
    `Buts encaissés         : ${stats.goalsAgainst}`
  );

  console.log(
    `Moy. buts marqués      : ${stats.averageGoalsFor.toFixed(2)}`
  );

  console.log(
    `Moy. buts encaissés    : ${stats.averageGoalsAgainst.toFixed(2)}`
  );

  console.log(
    "\n🏠 DOMICILE"
  );

  console.log(
    `Matchs                 : ${stats.homeMatches}`
  );

  console.log(
    `Buts marqués           : ${stats.homeGoalsFor}`
  );

  console.log(
    `Buts encaissés         : ${stats.homeGoalsAgainst}`
  );

  console.log(
    `Moy. buts marqués      : ${stats.homeAverageGoalsFor.toFixed(2)}`
  );

  console.log(
    `Moy. buts encaissés    : ${stats.homeAverageGoalsAgainst.toFixed(2)}`
  );

  console.log(
    "\n✈️ EXTÉRIEUR"
  );

  console.log(
    `Matchs                 : ${stats.awayMatches}`
  );

  console.log(
    `Buts marqués           : ${stats.awayGoalsFor}`
  );

  console.log(
    `Buts encaissés         : ${stats.awayGoalsAgainst}`
  );

  console.log(
    `Moy. buts marqués      : ${stats.awayAverageGoalsFor.toFixed(2)}`
  );

  console.log(
    `Moy. buts encaissés    : ${stats.awayAverageGoalsAgainst.toFixed(2)}`
  );
}


// ============================================================
// AFFICHAGE DES MATCHS UTILISÉS
// ============================================================

function printRecentMatches(
  team,
  stats
) {
  console.log(
    `\n📝 Derniers matchs utilisés — ${team.name}`
  );

  console.log(
    "----------------------------------------"
  );

  for (
    const match of
    stats.recentMatches
  ) {
    console.log(
      `• ${match.home} ` +
      `${match.home_score}-${match.away_score} ` +
      `${match.away} ` +
      `| ${match.time || "date inconnue"}`
    );
  }
}


// ============================================================
// AFFICHAGE DU CONTEXTE DU MODÈLE
// ============================================================

function printModelContext(
  homeTeam,
  awayTeam,
  homeStats,
  awayStats
) {
  const homeSplitAvailable =
    homeStats.homeMatches >=
    MIN_SPLIT_MATCHES;

  const awaySplitAvailable =
    awayStats.awayMatches >=
    MIN_SPLIT_MATCHES;

  console.log(
    "\n🧠 DONNÉES UTILISÉES PAR LE MODÈLE"
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `${homeTeam.name} :`
  );

  console.log(
    homeSplitAvailable
      ? `   🏠 statistiques domicile (${homeStats.homeMatches} matchs)`
      : `   ⚠️ domicile insuffisant → statistiques globales`
  );

  console.log(
    `${awayTeam.name} :`
  );

  console.log(
    awaySplitAvailable
      ? `   ✈️ statistiques extérieur (${awayStats.awayMatches} matchs)`
      : `   ⚠️ extérieur insuffisant → statistiques globales`
  );
}


// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================

async function main() {
  console.log(
    "========================================"
  );

  console.log(
    " BATBOT — TEST MOTEUR STATISTIQUE"
  );

  console.log(
    "========================================"
  );

  console.log(
    `\n⚽ Match : ${HOME_TEAM_NAME} vs ${AWAY_TEAM_NAME}`
  );

  // ----------------------------------------------------------
  // ÉQUIPES
  // ----------------------------------------------------------

  const homeTeam =
    await searchTeam(
      HOME_TEAM_NAME
    );

  const awayTeam =
    await searchTeam(
      AWAY_TEAM_NAME
    );

  console.log(
    "\n✅ ÉQUIPES RETENUES"
  );

  console.log(
    `   🏠 ${homeTeam.name} → ${homeTeam.slug}`
  );

  console.log(
    `   ✈️ ${awayTeam.name} → ${awayTeam.slug}`
  );

  // ----------------------------------------------------------
  // HISTORIQUE
  // ----------------------------------------------------------

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
      `${homeTeam.name}: moins de ${MIN_MATCHES} matchs historiques disponibles.`
    );
  }

  if (
    awayMatches.length <
    MIN_MATCHES
  ) {
    throw new Error(
      `${awayTeam.name}: moins de ${MIN_MATCHES} matchs historiques disponibles.`
    );
  }

  // ----------------------------------------------------------
  // STATISTIQUES
  // ----------------------------------------------------------

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

  printTeamStats(
    homeTeam,
    homeStats
  );

  printTeamStats(
    awayTeam,
    awayStats
  );

  printRecentMatches(
    homeTeam,
    homeStats
  );

  printRecentMatches(
    awayTeam,
    awayStats
  );

  printModelContext(
    homeTeam,
    awayTeam,
    homeStats,
    awayStats
  );

  // ----------------------------------------------------------
  // MOTEUR
  // ----------------------------------------------------------

  console.log(
    "\n========================================"
  );

  console.log(
    " 📊 CALCUL DU MOTEUR POISSON"
  );

  console.log(
    "========================================"
  );

  const result =
    calculateOdds({
      home: {
        matches:
          homeStats.matches,

        goalsFor:
          homeStats.goalsFor,

        goalsAgainst:
          homeStats.goalsAgainst,

        homeMatches:
          homeStats.homeMatches,

        homeGoalsFor:
          homeStats.homeGoalsFor,

        homeGoalsAgainst:
          homeStats.homeGoalsAgainst,

        awayMatches:
          homeStats.awayMatches,

        awayGoalsFor:
          homeStats.awayGoalsFor,

        awayGoalsAgainst:
          homeStats.awayGoalsAgainst
      },

      away: {
        matches:
          awayStats.matches,

        goalsFor:
          awayStats.goalsFor,

        goalsAgainst:
          awayStats.goalsAgainst,

        homeMatches:
          awayStats.homeMatches,

        homeGoalsFor:
          awayStats.homeGoalsFor,

        homeGoalsAgainst:
          awayStats.homeGoalsAgainst,

        awayMatches:
          awayStats.awayMatches,

        awayGoalsFor:
          awayStats.awayGoalsFor,

        awayGoalsAgainst:
          awayStats.awayGoalsAgainst
      }
    });

  if (
    !result.sufficientData
  ) {
    throw new Error(
      result.reason
    );
  }

  // ----------------------------------------------------------
  // BUTS ATTENDUS
  // ----------------------------------------------------------

  console.log(
    "\n⚽ BUTS ATTENDUS"
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `🏠 ${homeTeam.name} : ${result.expectedGoals.home}`
  );

  console.log(
    `✈️ ${awayTeam.name} : ${result.expectedGoals.away}`
  );

  console.log(
    `Modèle : ${result.model}`
  );

  // ----------------------------------------------------------
  // 1X2
  // ----------------------------------------------------------

  console.log(
    "\n📈 PROBABILITÉS 1X2"
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `1 — ${homeTeam.name} : ` +
    `${result.oneXTwo.home.probability}% ` +
    `| Cote théorique : ${result.oneXTwo.home.theoreticalOdds}`
  );

  console.log(
    `X — Nul : ` +
    `${result.oneXTwo.draw.probability}% ` +
    `| Cote théorique : ${result.oneXTwo.draw.theoreticalOdds}`
  );

  console.log(
    `2 — ${awayTeam.name} : ` +
    `${result.oneXTwo.away.probability}% ` +
    `| Cote théorique : ${result.oneXTwo.away.theoreticalOdds}`
  );

  // ----------------------------------------------------------
  // CONTRÔLE
  // ----------------------------------------------------------

  const total =
    result.oneXTwo.home.probability +
    result.oneXTwo.draw.probability +
    result.oneXTwo.away.probability;

  console.log(
    "\n🔎 CONTRÔLE DES PROBABILITÉS"
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `Total 1X2 : ${total.toFixed(2)}%`
  );

  if (
    Math.abs(total - 100) >=
    0.01
  ) {
    throw new Error(
      "Les probabilités 1X2 ne totalisent pas 100 %."
    );
  }

  console.log(
    "✅ Les probabilités 1X2 totalisent 100 %."
  );

  // ----------------------------------------------------------
  // SCORE
  // ----------------------------------------------------------

  console.log(
    "\n🎯 SCORE LE PLUS PROBABLE"
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `${result.mostLikelyScore.score} ` +
    `→ ${result.mostLikelyScore.probability}%`
  );

  // ----------------------------------------------------------
  // AUTRES MARCHÉS
  // ----------------------------------------------------------

  console.log(
    "\n📊 AUTRES MARCHÉS"
  );

  console.log(
    "----------------------------------------"
  );

  console.log(
    `1X       : ${result.markets["1X"].probability}% ` +
    `| Cote : ${result.markets["1X"].theoreticalOdds}`
  );

  console.log(
    `X2       : ${result.markets["X2"].probability}% ` +
    `| Cote : ${result.markets["X2"].theoreticalOdds}`
  );

  console.log(
    `12       : ${result.markets["12"].probability}% ` +
    `| Cote : ${result.markets["12"].theoreticalOdds}`
  );

  console.log(
    `Over 1.5 : ${result.markets.over15.probability}% ` +
    `| Cote : ${result.markets.over15.theoreticalOdds}`
  );

  console.log(
    `Over 2.5 : ${result.markets.over25.probability}% ` +
    `| Cote : ${result.markets.over25.theoreticalOdds}`
  );

  console.log(
    `Under 2.5: ${result.markets.under25.probability}% ` +
    `| Cote : ${result.markets.under25.theoreticalOdds}`
  );

  console.log(
    `Over 3.5 : ${result.markets.over35.probability}% ` +
    `| Cote : ${result.markets.over35.theoreticalOdds}`
  );

  console.log(
    `BTTS Oui  : ${result.markets.bttsYes.probability}% ` +
    `| Cote : ${result.markets.bttsYes.theoreticalOdds}`
  );

  console.log(
    `BTTS Non  : ${result.markets.bttsNo.probability}% ` +
    `| Cote : ${result.markets.bttsNo.theoreticalOdds}`
  );

  // ----------------------------------------------------------
  // FIN
  // ----------------------------------------------------------

  console.log(
    "\n========================================"
  );

  console.log(
    " ✅ TEST DU MOTEUR TERMINÉ AVEC SUCCÈS"
  );

  console.log(
    "========================================"
  );
}


main().catch(error => {
  console.error(
    "\n❌ ERREUR"
  );

  console.error(
    error.message
  );

  process.exit(1);
});

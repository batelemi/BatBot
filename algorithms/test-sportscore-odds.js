/**
 * BATBOT — SPORTScore → MOTEUR DE COTES
 *
 * Récupère les derniers matchs terminés de deux équipes
 * depuis SportScore puis les transmet au moteur statistique.
 */

"use strict";

const {
  calculateOdds
} = require("./odds-engine");


const SPORT = "football";

const API_BASE =
  "https://sportscore.com/api/v1";

const MIN_MATCHES = 5;

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

  let teams = [];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      teams.push(...candidate);
    }
  }

  const unique = [];

  const seen = new Set();

  for (const team of teams) {
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

    unique.push({
      ...team,
      name,
      slug
    });
  }

  console.log(
    `\n🔎 Résultats SportScore pour "${teamName}" :`
  );

  for (const team of unique) {
    console.log(
      `   • ${team.name} → ${team.slug}`
    );
  }

  const wanted =
    cleanText(teamName);

  const exact =
    unique.filter(
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
// CALENDRIER D'ÉQUIPE
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


async function fetchTeamSchedule(team) {
  const url =
    `${API_BASE}/team/` +
    `?sport=${SPORT}` +
    `&slug=${encodeURIComponent(team.slug)}` +
    `&limit=30`;

  const data =
    await fetchJson(url);

  return extractMatches(data);
}


// ============================================================
// EXTRACTION DES MATCHS TERMINÉS
// ============================================================

function isFinished(match) {
  return (
    cleanText(match?.status) === "finished"
  );
}


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
    Number.isFinite(Number(homeScore)) &&
    Number.isFinite(Number(awayScore)) &&
    Number(homeScore) >= 0 &&
    Number(awayScore) >= 0
  );
}


function matchBelongsToTeam(match, team) {
  const wanted =
    cleanText(team.name);

  const home =
    cleanText(match?.home);

  const away =
    cleanText(match?.away);

  return (
    home === wanted ||
    away === wanted
  );
}


function getGoalsForAndAgainst(match, team) {
  const home =
    cleanText(match?.home);

  const away =
    cleanText(match?.away);

  const homeScore =
    Number(match.home_score);

  const awayScore =
    Number(match.away_score);

  const wanted =
    cleanText(team.name);

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
// STATISTIQUES
// ============================================================

function buildTeamStats(matches, team) {
  const finished =
    matches
      .filter(isFinished)
      .filter(hasRealScore)
      .filter(match =>
        matchBelongsToTeam(match, team)
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

  for (const match of selected) {
    const goals =
      getGoalsForAndAgainst(
        match,
        team
      );

    if (!goals) {
      continue;
    }

    goalsFor += goals.goalsFor;
    goalsAgainst += goals.goalsAgainst;
  }

  return {
    matches: selected.length,
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
    recentMatches: selected
  };
}


// ============================================================
// AFFICHAGE
// ============================================================

function printTeamStats(title, team, stats) {
  console.log(`\n${title}`);
  console.log("----------------------------------------");

  console.log(
    "Équipe :",
    team.name
  );

  console.log(
    "Slug :",
    team.slug
  );

  console.log(
    "Matchs terminés avec score :",
    stats.matches
  );

  console.log(
    "Buts marqués :",
    stats.goalsFor
  );

  console.log(
    "Buts encaissés :",
    stats.goalsAgainst
  );

  console.log(
    "Moyenne buts marqués :",
    stats.averageGoalsFor.toFixed(2)
  );

  console.log(
    "Moyenne buts encaissés :",
    stats.averageGoalsAgainst.toFixed(2)
  );

  console.log(
    "\nDerniers matchs utilisés :"
  );

  if (!stats.recentMatches.length) {
    console.log(
      "   Aucun match exploitable."
    );

    return;
  }

  for (const match of stats.recentMatches) {
    console.log(
      `   ${match.home} ${match.home_score}-${match.away_score} ${match.away}` +
      ` | ${match.time || "date inconnue"}`
    );
  }
}


// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================

async function main() {
  console.log("========================================");
  console.log(" BATBOT — SPORTScore → MOTEUR DE COTES");
  console.log("========================================");

  console.log("\nMatch testé :");
  console.log(
    `${HOME_TEAM_NAME} vs ${AWAY_TEAM_NAME}`
  );

  console.log(
    "\n🔎 Recherche des équipes..."
  );

  const homeTeam =
    await searchTeam(
      HOME_TEAM_NAME
    );

  const awayTeam =
    await searchTeam(
      AWAY_TEAM_NAME
    );

  console.log("\n✅ ÉQUIPES RETENUES");
  console.log("----------------------------------------");

  console.log(
    `Domicile : ${homeTeam.name} → ${homeTeam.slug}`
  );

  console.log(
    `Extérieur : ${awayTeam.name} → ${awayTeam.slug}`
  );

  console.log(
    "\n⏳ Récupération des calendriers SportScore..."
  );

  const homeMatches =
    await fetchTeamSchedule(
      homeTeam
    );

  const awayMatches =
    await fetchTeamSchedule(
      awayTeam
    );

  console.log(
    `Matchs récupérés domicile : ${homeMatches.length}`
  );

  console.log(
    `Matchs récupérés extérieur : ${awayMatches.length}`
  );


  // ==========================================================
  // STATISTIQUES
  // ==========================================================

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
    "\n🏠 ÉQUIPE À DOMICILE",
    homeTeam,
    homeStats
  );

  printTeamStats(
    "\n✈️ ÉQUIPE À L'EXTÉRIEUR",
    awayTeam,
    awayStats
  );


  // ==========================================================
  // CONTRÔLE DES DONNÉES
  // ==========================================================

  if (
    homeStats.matches < MIN_MATCHES
  ) {
    console.log(
      "\n⚠️ DONNÉES INSUFFISANTES POUR L'ÉQUIPE À DOMICILE"
    );

    console.log(
      `Il faut au moins ${MIN_MATCHES} matchs terminés avec score réel.`
    );

    process.exit(1);
  }


  if (
    awayStats.matches < MIN_MATCHES
  ) {
    console.log(
      "\n⚠️ DONNÉES INSUFFISANTES POUR L'ÉQUIPE À L'EXTÉRIEUR"
    );

    console.log(
      `Il faut au moins ${MIN_MATCHES} matchs terminés avec score réel.`
    );

    process.exit(1);
  }


  // ==========================================================
  // MOTEUR DE COTES
  // ==========================================================

  console.log(
    "\n========================================"
  );

  console.log(
    " 📊 CALCUL DU MOTEUR STATISTIQUE"
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
          homeStats.goalsAgainst
      },

      away: {
        matches:
          awayStats.matches,

        goalsFor:
          awayStats.goalsFor,

        goalsAgainst:
          awayStats.goalsAgainst
      }
    });


  if (!result.sufficientData) {
    console.log(
      "\n❌ Données insuffisantes"
    );

    console.log(
      result.reason
    );

    process.exit(1);
  }


  // ==========================================================
  // RÉSULTATS
  // ==========================================================

  console.log(
    "\n📈 BUTS ATTENDUS"
  );

  console.log("----------------------------------------");

  console.log(
    "Real Madrid :",
    result.expectedGoals.home
  );

  console.log(
    "FC Barcelona :",
    result.expectedGoals.away
  );


  console.log(
    "\n⚽ PROBABILITÉS 1X2"
  );

  console.log("----------------------------------------");

  console.log(
    "1 — Victoire domicile :",
    result.oneXTwo.home.probability + "%",
    "| Cote :",
    result.oneXTwo.home.theoreticalOdds
  );

  console.log(
    "X — Match nul :",
    result.oneXTwo.draw.probability + "%",
    "| Cote :",
    result.oneXTwo.draw.theoreticalOdds
  );

  console.log(
    "2 — Victoire extérieur :",
    result.oneXTwo.away.probability + "%",
    "| Cote :",
    result.oneXTwo.away.theoreticalOdds
  );


  console.log(
    "\n🔎 CONTRÔLE 1X2"
  );

  console.log("----------------------------------------");

  const total =
    result.oneXTwo.home.probability +
    result.oneXTwo.draw.probability +
    result.oneXTwo.away.probability;

  console.log(
    "Total :",
    total.toFixed(2) + "%"
  );


  if (
    Math.abs(total - 100) < 0.01
  ) {
    console.log(
      "✅ Les probabilités totalisent 100 %"
    );
  } else {
    console.log(
      "❌ ERREUR : les probabilités ne totalisent pas 100 %"
    );

    process.exit(1);
  }


  console.log(
    "\n🎯 SCORE LE PLUS PROBABLE"
  );

  console.log("----------------------------------------");

  console.log(
    result.mostLikelyScore.score,
    "—",
    result.mostLikelyScore.probability + "%"
  );


  console.log(
    "\n📈 AUTRES MARCHÉS"
  );

  console.log("----------------------------------------");

  console.log(
    "1X :",
    result.markets["1X"].probability + "%",
    "| Cote :",
    result.markets["1X"].theoreticalOdds
  );

  console.log(
    "X2 :",
    result.markets["X2"].probability + "%",
    "| Cote :",
    result.markets["X2"].theoreticalOdds
  );

  console.log(
    "12 :",
    result.markets["12"].probability + "%",
    "| Cote :",
    result.markets["12"].theoreticalOdds
  );

  console.log(
    "Over 2.5 :",
    result.markets.over25.probability + "%",
    "| Cote :",
    result.markets.over25.theoreticalOdds
  );

  console.log(
    "Under 2.5 :",
    result.markets.under25.probability + "%",
    "| Cote :",
    result.markets.under25.theoreticalOdds
  );

  console.log(
    "BTTS Oui :",
    result.markets.bttsYes.probability + "%",
    "| Cote :",
    result.markets.bttsYes.theoreticalOdds
  );

  console.log(
    "BTTS Non :",
    result.markets.bttsNo.probability + "%",
    "| Cote :",
    result.markets.bttsNo.theoreticalOdds
  );


  console.log(
    "\n========================================"
  );

  console.log(
    " ✅ TEST DU MOTEUR TERMINÉ"
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

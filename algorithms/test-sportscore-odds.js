/**
 * BATBOT — TEST DU MOTEUR DE COTES AVEC SPORTScore
 *
 * Ce fichier :
 * 1. recherche deux équipes sur SportScore
 * 2. récupère leurs derniers matchs
 * 3. conserve uniquement les matchs terminés avec un vrai score
 * 4. calcule les statistiques buts marqués / encaissés
 * 5. transmet ces statistiques à odds-engine.js
 * 6. affiche les probabilités et cotes théoriques
 *
 * Ce fichier est indépendant de server.js.
 */

"use strict";

const {
  calculateOdds
} = require("./odds-engine");

const SPORT = "football";
const BASE_URL = "https://sportscore.com/api/v1";

const HOME_TEAM_NAME =
  process.argv[2] || "Real Madrid";

const AWAY_TEAM_NAME =
  process.argv[3] || "Barcelona";

const MATCH_LIMIT = 15;
const REQUIRED_MATCHES = 5;

/* -------------------------------------------------- */
/* OUTILS                                             */
/* -------------------------------------------------- */

function cleanText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function unwrap(value) {
  if (!value) return null;

  return (
    value.data ||
    value.response ||
    value.result ||
    value
  );
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} — ${url}`
    );
  }

  return response.json();
}

/* -------------------------------------------------- */
/* RECHERCHE ÉQUIPE                                  */
/* -------------------------------------------------- */

async function searchTeam(teamName) {
  const url =
    `${BASE_URL}/search/` +
    `?sport=${encodeURIComponent(SPORT)}` +
    `&q=${encodeURIComponent(teamName)}` +
    `&limit=10`;

  const data = await fetchJson(url);

  const root = unwrap(data) || {};

  const candidates = [];

  function collect(value) {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }

    if (typeof value !== "object") return;

    const name =
      value.name ||
      value.team_name ||
      value.title;

    const slug =
      value.slug ||
      value.team_slug;

    if (name && slug) {
      candidates.push({
        name: String(name),
        slug: String(slug)
      });
    }

    for (const key of Object.keys(value)) {
      const child = value[key];

      if (
        typeof child === "object" &&
        child !== null
      ) {
        collect(child);
      }
    }
  }

  collect(root);

  const wanted = cleanText(teamName);

  const exact =
    candidates.find(
      item =>
        cleanText(item.name) === wanted
    );

  const partial =
    candidates.find(
      item =>
        cleanText(item.name).includes(wanted) ||
        wanted.includes(cleanText(item.name))
    );

  const selected = exact || partial || candidates[0];

  if (!selected) {
    throw new Error(
      `Équipe introuvable sur SportScore : ${teamName}`
    );
  }

  return selected;
}

/* -------------------------------------------------- */
/* EXTRACTION DES MATCHS                             */
/* -------------------------------------------------- */

function extractMatches(data) {
  const root = unwrap(data);

  const possibleArrays = [
    root?.matches,
    root?.fixtures,
    root?.games,
    root?.events,
    root?.schedule,
    root?.data?.matches,
    root?.data?.fixtures,
    root?.response?.matches,
    root?.response?.fixtures
  ];

  for (const list of possibleArrays) {
    if (Array.isArray(list)) {
      return list;
    }
  }

  return [];
}

/* -------------------------------------------------- */
/* STATUT                                           */
/* -------------------------------------------------- */

function getStatus(match) {
  return cleanText(
    match?.status ||
    match?.status_key ||
    match?.status_text ||
    match?.state ||
    match?.match_status
  );
}

function isFinished(match) {
  const status = getStatus(match);

  return (
    status.includes("finished") ||
    status.includes("complete") ||
    status.includes("final") ||
    status.includes("termin")
  );
}

/* -------------------------------------------------- */
/* SCORE                                            */
/* -------------------------------------------------- */

function getScore(match) {
  const homeScore =
    match?.home_score ??
    match?.home?.score ??
    match?.scores?.home ??
    match?.score?.home;

  const awayScore =
    match?.away_score ??
    match?.away?.score ??
    match?.scores?.away ??
    match?.score?.away;

  if (
    homeScore === null ||
    homeScore === undefined ||
    awayScore === null ||
    awayScore === undefined
  ) {
    return null;
  }

  const home = Number(homeScore);
  const away = Number(awayScore);

  if (
    !Number.isFinite(home) ||
    !Number.isFinite(away) ||
    home < 0 ||
    away < 0
  ) {
    return null;
  }

  return {
    home,
    away
  };
}

/* -------------------------------------------------- */
/* NOMS DES ÉQUIPES                                 */
/* -------------------------------------------------- */

function getTeamName(match, side) {
  if (side === "home") {
    return String(
      match?.home ||
      match?.home_team ||
      match?.homeTeam ||
      match?.teams?.home?.name ||
      ""
    );
  }

  return String(
    match?.away ||
    match?.away_team ||
    match?.awayTeam ||
    match?.teams?.away?.name ||
    ""
  );
}

/* -------------------------------------------------- */
/* STATISTIQUES D'UNE ÉQUIPE                        */
/* -------------------------------------------------- */

function calculateTeamStats(
  matches,
  team
) {
  const teamSlug =
    cleanText(team.slug);

  const teamName =
    cleanText(team.name);

  const completed = [];

  for (const match of matches) {
    if (!isFinished(match)) {
      continue;
    }

    const score =
      getScore(match);

    /*
     * Aucun score inventé.
     */
    if (!score) {
      continue;
    }

    const homeName =
      cleanText(
        getTeamName(match, "home")
      );

    const awayName =
      cleanText(
        getTeamName(match, "away")
      );

    const isHome =
      homeName === teamName ||
      homeName.includes(teamName) ||
      teamName.includes(homeName);

    const isAway =
      awayName === teamName ||
      awayName.includes(teamName) ||
      teamName.includes(awayName);

    if (!isHome && !isAway) {
      continue;
    }

    if (isHome) {
      completed.push({
        goalsFor: score.home,
        goalsAgainst: score.away
      });
    } else if (isAway) {
      completed.push({
        goalsFor: score.away,
        goalsAgainst: score.home
      });
    }
  }

  const recent =
    completed.slice(
      0,
      REQUIRED_MATCHES
    );

  const goalsFor =
    recent.reduce(
      (total, match) =>
        total + match.goalsFor,
      0
    );

  const goalsAgainst =
    recent.reduce(
      (total, match) =>
        total + match.goalsAgainst,
      0
    );

  return {
    matches: recent.length,
    goalsFor,
    goalsAgainst,
    averageGoalsFor:
      recent.length
        ? Number(
            (goalsFor / recent.length)
              .toFixed(2)
          )
        : 0,
    averageGoalsAgainst:
      recent.length
        ? Number(
            (goalsAgainst / recent.length)
              .toFixed(2)
          )
        : 0
  };
}

/* -------------------------------------------------- */
/* RÉCUPÉRATION DU CALENDRIER                       */
/* -------------------------------------------------- */

async function getTeamFixtures(team) {
  const url =
    `${BASE_URL}/team/` +
    `?sport=${encodeURIComponent(SPORT)}` +
    `&slug=${encodeURIComponent(team.slug)}` +
    `&limit=${MATCH_LIMIT}`;

  const data =
    await fetchJson(url);

  return extractMatches(data);
}

/* -------------------------------------------------- */
/* AFFICHAGE                                         */
/* -------------------------------------------------- */

function printTeamStats(
  label,
  team,
  stats
) {
  console.log(`\n${label}`);
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
    "Matchs exploitables :",
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
    stats.averageGoalsFor
  );

  console.log(
    "Moyenne buts encaissés :",
    stats.averageGoalsAgainst
  );
}

/* -------------------------------------------------- */
/* PROGRAMME PRINCIPAL                              */
/* -------------------------------------------------- */

async function main() {
  console.log("========================================");
  console.log(" BATBOT — SPORTScore → MOTEUR DE COTES");
  console.log("========================================");

  console.log(
    "\nRecherche :",
    HOME_TEAM_NAME,
    "vs",
    AWAY_TEAM_NAME
  );

  try {
    /* Recherche des équipes */

    const homeTeam =
      await searchTeam(
        HOME_TEAM_NAME
      );

    const awayTeam =
      await searchTeam(
        AWAY_TEAM_NAME
      );

    console.log("\n✅ ÉQUIPES TROUVÉES");
    console.log("----------------------------------------");

    console.log(
      "Domicile :",
      homeTeam.name,
      "→",
      homeTeam.slug
    );

    console.log(
      "Extérieur :",
      awayTeam.name,
      "→",
      awayTeam.slug
    );

    /* Récupération des matchs */

    console.log(
      "\n⏳ Récupération des derniers matchs..."
    );

    const homeFixtures =
      await getTeamFixtures(
        homeTeam
      );

    const awayFixtures =
      await getTeamFixtures(
        awayTeam
      );

    console.log(
      "Matchs récupérés domicile :",
      homeFixtures.length
    );

    console.log(
      "Matchs récupérés extérieur :",
      awayFixtures.length
    );

    /* Statistiques */

    const homeStats =
      calculateTeamStats(
        homeFixtures,
        homeTeam
      );

    const awayStats =
      calculateTeamStats(
        awayFixtures,
        awayTeam
      );

    printTeamStats(
      "🏠 ÉQUIPE À DOMICILE",
      homeTeam,
      homeStats
    );

    printTeamStats(
      "✈️ ÉQUIPE À L'EXTÉRIEUR",
      awayTeam,
      awayStats
    );

    /* Vérification des données */

    if (
      homeStats.matches <
      REQUIRED_MATCHES ||
      awayStats.matches <
      REQUIRED_MATCHES
    ) {
      console.log(
        "\n⚠️ DONNÉES INSUFFISANTES"
      );

      console.log(
        `Le moteur nécessite au moins ${REQUIRED_MATCHES} ` +
        "matchs terminés avec score pour chaque équipe."
      );

      process.exit(1);
    }

    /* Moteur de cotes */

    console.log(
      "\n🧮 CALCUL DU MODÈLE..."
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

    console.log(
      "\n📊 RÉSULTAT DU MODÈLE"
    );

    console.log("----------------------------------------");

    console.log(
      "Modèle :",
      result.model
    );

    console.log(
      "Buts attendus domicile :",
      result.expectedGoals.home
    );

    console.log(
      "Buts attendus extérieur :",
      result.expectedGoals.away
    );

    console.log(
      "\n⚽ PROBABILITÉS 1X2"
    );

    console.log("----------------------------------------");

    console.log(
      "1 — Domicile :",
      result.oneXTwo.home.probability + "%",
      "| Cote :",
      result.oneXTwo.home.theoreticalOdds
    );

    console.log(
      "X — Nul :",
      result.oneXTwo.draw.probability + "%",
      "| Cote :",
      result.oneXTwo.draw.theoreticalOdds
    );

    console.log(
      "2 — Extérieur :",
      result.oneXTwo.away.probability + "%",
      "| Cote :",
      result.oneXTwo.away.theoreticalOdds
    );

    /* Contrôle 100 % */

    const total =
      result.oneXTwo.home.probability +
      result.oneXTwo.draw.probability +
      result.oneXTwo.away.probability;

    console.log(
      "\n🔎 CONTRÔLE 1X2"
    );

    console.log("----------------------------------------");

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
        "❌ ERREUR : le total 1X2 n'est pas égal à 100 %"
      );

      process.exit(1);
    }

    /* Score probable */

    console.log(
      "\n🎯 SCORE LE PLUS PROBABLE"
    );

    console.log("----------------------------------------");

    console.log(
      result.mostLikelyScore.score,
      "—",
      result.mostLikelyScore.probability +
        "%"
    );

    /* Marchés */

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
      " ✅ TEST SPORTScore TERMINÉ"
    );

    console.log(
      "========================================"
    );

  } catch (error) {
    console.error(
      "\n❌ ERREUR"
    );

    console.error(
      error.message
    );

    process.exit(1);
  }
}

main();

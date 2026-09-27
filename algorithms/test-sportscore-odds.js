/**
 * BATBOT — TEST DU MOTEUR DE COTES AVEC SPORTScore
 *
 * Objectif :
 * 1. rechercher les équipes sur SportScore
 * 2. sélectionner une équipe sans ambiguïté
 * 3. récupérer son calendrier
 * 4. conserver uniquement les matchs terminés
 * 5. conserver uniquement les matchs avec score réel
 * 6. utiliser les derniers matchs exploitables
 * 7. transmettre les statistiques au moteur odds-engine.js
 * 8. afficher les probabilités et cotes théoriques
 *
 * IMPORTANT :
 * Aucun résultat ambigu n'est accepté.
 * Le moteur ne doit jamais calculer une cote
 * avec une mauvaise équipe.
 */

"use strict";

const {
  calculateOdds
} = require("./odds-engine");

/* ================================================== */
/* CONFIGURATION                                      */
/* ================================================== */

const SPORT = "football";

const BASE_URL =
  "https://sportscore.com/api/v1";

const HOME_TEAM_NAME =
  process.argv[2] || "Real Madrid";

const AWAY_TEAM_NAME =
  process.argv[3] || "FC Barcelona";

const MATCH_LIMIT = 30;

const REQUIRED_MATCHES = 5;

/* ================================================== */
/* OUTILS                                             */
/* ================================================== */

function cleanText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `SportScore HTTP ${response.status}`
    );
  }

  return response.json();
}

function unwrapResponse(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (
    data.data &&
    typeof data.data === "object"
  ) {
    return data.data;
  }

  if (
    data.response &&
    typeof data.response === "object"
  ) {
    return data.response;
  }

  if (
    data.result &&
    typeof data.result === "object"
  ) {
    return data.result;
  }

  return data;
}

/* ================================================== */
/* RECHERCHE ÉQUIPE                                   */
/* ================================================== */

async function searchTeam(teamName) {
  const url =
    `${BASE_URL}/search/` +
    `?sport=${encodeURIComponent(SPORT)}` +
    `&q=${encodeURIComponent(teamName)}` +
    `&limit=20`;

  const data =
    await fetchJson(url);

  const root =
    unwrapResponse(data);

  const candidates = [];

  function collect(value) {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }

      return;
    }

    if (
      typeof value !== "object"
    ) {
      return;
    }

    const name =
      value.name ||
      value.team_name ||
      value.teamName ||
      value.title;

    const slug =
      value.slug ||
      value.team_slug ||
      value.teamSlug;

    if (
      name &&
      slug
    ) {
      candidates.push({
        name: String(name),
        slug: String(slug)
      });
    }

    for (
      const key of Object.keys(value)
    ) {
      const child =
        value[key];

      if (
        child &&
        typeof child === "object"
      ) {
        collect(child);
      }
    }
  }

  collect(root);

  const unique =
    Array.from(
      new Map(
        candidates.map(item => [
          `${cleanText(item.name)}|${item.slug}`,
          item
        ])
      ).values()
    );

  if (!unique.length) {
    throw new Error(
      `Aucune équipe trouvée sur SportScore pour : ${teamName}`
    );
  }

  const wanted =
    cleanText(teamName);

  console.log(
    `\n🔎 Résultats SportScore pour "${teamName}" :`
  );

  for (const candidate of unique.slice(0, 10)) {
    console.log(
      `   • ${candidate.name} → ${candidate.slug}`
    );
  }

  /*
   * 1. Correspondance exacte du nom demandé.
   */
  const exact =
    unique.filter(
      item =>
        cleanText(item.name) === wanted
    );

  if (exact.length === 1) {
    return exact[0];
  }

  if (exact.length > 1) {
    throw new Error(
      `Recherche ambiguë pour "${teamName}" : plusieurs équipes portent exactement ce nom.`
    );
  }

  /*
   * 2. Correspondance stricte avec le slug.
   *
   * Exemple :
   * FC Barcelona → fc-barcelona
   * Barcelona → barcelona
   */
  const slugWanted =
    wanted
      .replace(/\bfc\b/g, "")
      .trim()
      .replace(/\s+/g, "-");

  const slugMatches =
    unique.filter(item => {
      const slug =
        cleanText(item.slug);

      return (
        slug === wanted.replace(/\s+/g, "-") ||
        slug === slugWanted ||
        slug === wanted.replace(/\s+/g, "-") + "-fc"
      );
    });

  if (slugMatches.length === 1) {
    return slugMatches[0];
  }

  /*
   * 3. Recherche de correspondance
   * sur les mots importants du nom.
   *
   * On refuse le premier résultat.
   */
  const wantedWords =
    wanted
      .split(/\s+/)
      .filter(
        word =>
          word.length >= 3 &&
          word !== "fc" &&
          word !== "cf"
      );

  const scored =
    unique.map(item => {
      const candidate =
        cleanText(item.name);

      let score = 0;

      for (const word of wantedWords) {
        if (candidate.includes(word)) {
          score += 1;
        }
      }

      return {
        item,
        score
      };
    })
    .filter(item => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score
    );

  if (!scored.length) {
    throw new Error(
      `Impossible d'identifier précisément l'équipe "${teamName}" sur SportScore.`
    );
  }

  const bestScore =
    scored[0].score;

  const best =
    scored.filter(
      item =>
        item.score === bestScore
    );

  /*
   * Si plusieurs équipes ont le même niveau
   * de correspondance, on refuse.
   */
  if (best.length !== 1) {
    throw new Error(
      `Équipe ambiguë pour "${teamName}". ` +
      `SportScore retourne plusieurs correspondances possibles. ` +
      `Utilise le nom complet du club.`
    );
  }

  return best[0].item;
}

/* ================================================== */
/* EXTRACTION DES MATCHS                              */
/* ================================================== */

function looksLikeMatch(item) {
  if (
    !item ||
    typeof item !== "object"
  ) {
    return false;
  }

  const hasHome =
    Boolean(
      item.home ||
      item.home_team ||
      item.homeTeam ||
      item.teams?.home
    );

  const hasAway =
    Boolean(
      item.away ||
      item.away_team ||
      item.awayTeam ||
      item.teams?.away
    );

  const hasStatus =
    Boolean(
      item.status ||
      item.status_key ||
      item.status_text ||
      item.match_status ||
      item.state
    );

  const hasScore =
    item.home_score !== undefined ||
    item.away_score !== undefined ||
    item.score !== undefined ||
    item.scores !== undefined;

  return (
    hasHome &&
    hasAway &&
    (hasStatus || hasScore)
  );
}

function findMatchArray(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    const matches =
      value.filter(
        looksLikeMatch
      );

    if (matches.length) {
      return matches;
    }

    for (
      const item of value
    ) {
      const result =
        findMatchArray(item);

      if (result) {
        return result;
      }
    }

    return null;
  }

  if (
    typeof value !== "object"
  ) {
    return null;
  }

  const preferredKeys = [
    "matches",
    "fixtures",
    "games",
    "events",
    "schedule"
  ];

  for (
    const key of preferredKeys
  ) {
    if (
      value[key] !== undefined
    ) {
      const result =
        findMatchArray(
          value[key]
        );

      if (result) {
        return result;
      }
    }
  }

  for (
    const key of Object.keys(value)
  ) {
    const result =
      findMatchArray(
        value[key]
      );

    if (result) {
      return result;
    }
  }

  return null;
}

function extractMatches(data) {
  const root =
    unwrapResponse(data);

  return (
    findMatchArray(root) ||
    []
  );
}

/* ================================================== */
/* STATUT                                             */
/* ================================================== */

function getStatus(match) {
  return cleanText(
    match?.status ||
    match?.status_key ||
    match?.status_text ||
    match?.match_status ||
    match?.state
  );
}

function isFinished(match) {
  const status =
    getStatus(match);

  return (
    status === "finished" ||
    status === "finish" ||
    status === "completed" ||
    status === "complete" ||
    status === "final" ||
    status === "ft" ||
    status === "full time" ||
    status.includes("finished") ||
    status.includes("termin")
  );
}

/* ================================================== */
/* SCORE                                              */
/* ================================================== */

function getScore(match) {
  const homeValue =
    match?.home_score ??
    match?.homeScore ??
    match?.score?.home ??
    match?.scores?.home ??
    match?.scores?.home_score;

  const awayValue =
    match?.away_score ??
    match?.awayScore ??
    match?.score?.away ??
    match?.scores?.away ??
    match?.scores?.away_score;

  /*
   * Un score absent n'est jamais transformé
   * en 0-0.
   */
  if (
    homeValue === null ||
    homeValue === undefined ||
    homeValue === "" ||
    awayValue === null ||
    awayValue === undefined ||
    awayValue === ""
  ) {
    return null;
  }

  const home =
    Number(homeValue);

  const away =
    Number(awayValue);

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

/* ================================================== */
/* NOMS DES ÉQUIPES                                  */
/* ================================================== */

function extractTeamName(value) {
  if (
    typeof value === "string"
  ) {
    return value;
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return (
      value.name ||
      value.team_name ||
      value.teamName ||
      ""
    );
  }

  return "";
}

function getTeamName(
  match,
  side
) {
  if (side === "home") {
    return extractTeamName(
      match?.home ||
      match?.home_team ||
      match?.homeTeam ||
      match?.teams?.home
    );
  }

  return extractTeamName(
    match?.away ||
    match?.away_team ||
    match?.awayTeam ||
    match?.teams?.away
  );
}

/* ================================================== */
/* DATE                                               */
/* ================================================== */

function getMatchTime(match) {
  const value =
    match?.time ||
    match?.date ||
    match?.datetime ||
    match?.start_time ||
    match?.startTime;

  if (!value) {
    return 0;
  }

  const timestamp =
    Date.parse(value);

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

/* ================================================== */
/* APPARTENANCE ÉQUIPE                               */
/* ================================================== */

function matchBelongsToTeam(
  match,
  team
) {
  const wanted =
    cleanText(team.name);

  const home =
    cleanText(
      getTeamName(
        match,
        "home"
      )
    );

  const away =
    cleanText(
      getTeamName(
        match,
        "away"
      )
    );

  return (
    home === wanted ||
    away === wanted
  );
}

/* ================================================== */
/* STATISTIQUES                                       */
/* ================================================== */

function calculateTeamStats(
  matches,
  team
) {
  const completed = [];

  for (
    const match of matches
  ) {
    if (!isFinished(match)) {
      continue;
    }

    const score =
      getScore(match);

    if (!score) {
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

    const homeName =
      cleanText(
        getTeamName(
          match,
          "home"
        )
      );

    const teamName =
      cleanText(team.name);

    const isHome =
      homeName === teamName;

    const goalsFor =
      isHome
        ? score.home
        : score.away;

    const goalsAgainst =
      isHome
        ? score.away
        : score.home;

    completed.push({
      date:
        getMatchTime(match),

      goalsFor,

      goalsAgainst,

      home:
        getTeamName(
          match,
          "home"
        ),

      away:
        getTeamName(
          match,
          "away"
        ),

      score:
        `${score.home}-${score.away}`
    });
  }

  completed.sort(
    (a, b) =>
      b.date - a.date
  );

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
    matches:
      recent.length,

    goalsFor,

    goalsAgainst,

    averageGoalsFor:
      recent.length
        ? Number(
            (
              goalsFor /
              recent.length
            ).toFixed(2)
          )
        : 0,

    averageGoalsAgainst:
      recent.length
        ? Number(
            (
              goalsAgainst /
              recent.length
            ).toFixed(2)
          )
        : 0,

    recent
  };
}

/* ================================================== */
/* CALENDRIER SPORTSCORE                              */
/* ================================================== */

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

/* ================================================== */
/* AFFICHAGE                                          */
/* ================================================== */

function printRecentMatches(
  stats
) {
  if (!stats.recent.length) {
    console.log(
      "   Aucun match exploitable."
    );

    return;
  }

  for (
    const match of stats.recent
  ) {
    console.log(
      `   ${match.home} ${match.score} ${match.away}`
    );
  }
}

function printTeamStats(
  label,
  team,
  stats
) {
  console.log(`\n${label}`);

  console.log(
    "----------------------------------------"
  );

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

  console.log(
    "\nDerniers matchs utilisés :"
  );

  printRecentMatches(stats);
}

/* ================================================== */
/* PROGRAMME PRINCIPAL                                */
/* ================================================== */

async function main() {
  console.log(
    "========================================"
  );

  console.log(
    " BATBOT — SPORTScore → MOTEUR DE COTES"
  );

  console.log(
    "========================================"
  );

  console.log(
    "\nMatch testé :"
  );

  console.log(
    `${HOME_TEAM_NAME} vs ${AWAY_TEAM_NAME}`
  );

  try {
    /* ---------------------------------------- */
    /* RECHERCHE                               */
    /* ---------------------------------------- */

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

    console.log(
      "\n✅ ÉQUIPES RETENUES"
    );

    console.log(
      "----------------------------------------"
    );

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

    /* ---------------------------------------- */
    /* CALENDRIERS                             */
    /* ---------------------------------------- */

    console.log(
      "\n⏳ Récupération des calendriers SportScore..."
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

    /* ---------------------------------------- */
    /* STATISTIQUES                            */
    /* ---------------------------------------- */

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

    /* ---------------------------------------- */
    /* CONTRÔLE DONNÉES                       */
    /* ---------------------------------------- */

    if (
      homeStats.matches <
      REQUIRED_MATCHES
    ) {
      console.log(
        "\n⚠️ DONNÉES INSUFFISANTES POUR L'ÉQUIPE À DOMICILE"
      );

      console.log(
        `Il faut au moins ${REQUIRED_MATCHES} ` +
        "matchs terminés avec score réel."
      );

      process.exit(1);
    }

    if (
      awayStats.matches <
      REQUIRED_MATCHES
    ) {
      console.log(
        "\n⚠️ DONNÉES INSUFFISANTES POUR L'ÉQUIPE À L'EXTÉRIEUR"
      );

      console.log(
        `Il faut au moins ${REQUIRED_MATCHES} ` +
        "matchs terminés avec score réel."
      );

      process.exit(1);
    }

    /* ---------------------------------------- */
    /* MOTEUR DE COTES                        */
    /* ---------------------------------------- */

    console.log(
      "\n🧮 Transmission au moteur odds-engine.js..."
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

    if (
      !result.sufficientData
    ) {
      console.log(
        "\n⚠️ DONNÉES INSUFFISANTES"
      );

      console.log(
        result.reason
      );

      process.exit(1);
    }

    /* ---------------------------------------- */
    /* RÉSULTAT                               */
    /* ---------------------------------------- */

    console.log(
      "\n📊 RÉSULTAT DU MODÈLE"
    );

    console.log(
      "----------------------------------------"
    );

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

    /* ---------------------------------------- */
    /* 1X2                                    */
    /* ---------------------------------------- */

    console.log(
      "\n⚽ PROBABILITÉS 1X2"
    );

    console.log(
      "----------------------------------------"
    );

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

    /* ---------------------------------------- */
    /* CONTRÔLE 100 %                         */
    /* ---------------------------------------- */

    const total =
      result.oneXTwo.home.probability +
      result.oneXTwo.draw.probability +
      result.oneXTwo.away.probability;

    console.log(
      "\n🔎 CONTRÔLE 1X2"
    );

    console.log(
      "----------------------------------------"
    );

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
        "❌ ERREUR : les probabilités 1X2 ne totalisent pas 100 %"
      );

      process.exit(1);
    }

    /* ---------------------------------------- */
    /* SCORE PROBABLE                         */
    /* ---------------------------------------- */

    console.log(
      "\n🎯 SCORE LE PLUS PROBABLE"
    );

    console.log(
      "----------------------------------------"
    );

    console.log(
      result.mostLikelyScore.score,
      "—",
      result.mostLikelyScore.probability + "%"
    );

    /* ---------------------------------------- */
    /* AUTRES MARCHÉS                         */
    /* ---------------------------------------- */

    console.log(
      "\n📈 AUTRES MARCHÉS"
    );

    console.log(
      "----------------------------------------"
    );

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
      "\n❌ ERREUR SPORTScore"
    );

    console.error(
      error.message
    );

    process.exit(1);
  }
}

main();

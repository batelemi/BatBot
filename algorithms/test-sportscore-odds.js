/**
 * BATBOT — DIAGNOSTIC SPORTScore
 *
 * Cette version sert uniquement à inspecter la structure
 * réelle des matchs retournés par SportScore.
 *
 * Elle ne calcule pas encore les cotes.
 */

"use strict";

const SPORT = "football";

const HOME_TEAM_NAME =
  process.argv[2] || "Real Madrid";

const AWAY_TEAM_NAME =
  process.argv[3] || "FC Barcelona";

const API_BASE =
  "https://sportscore.com/api/v1";


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


function slugify(value) {
  return cleanText(value)
    .replace(/\bfc\b/g, "")
    .trim()
    .replace(/\s+/g, "-");
}


// ============================================================
// APPEL API
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

  const groups = [
    data?.teams,
    data?.data?.teams,
    data?.results?.teams,
    data?.data?.results?.teams
  ];

  let teams = [];

  for (const group of groups) {
    if (Array.isArray(group)) {
      teams.push(...group);
    }
  }

  if (!teams.length && Array.isArray(data?.results)) {
    teams = data.results;
  }

  if (!teams.length && Array.isArray(data?.data)) {
    teams = data.data;
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

  if (!unique.length) {
    throw new Error(
      `Aucune équipe trouvée pour "${teamName}".`
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

  /*
   * Pour éviter les faux positifs :
   *
   * FC Barcelona doit rester FC Barcelona.
   * On ne transforme donc pas "fc-barcelona"
   * en simple "barcelona" pour sélectionner
   * une autre équipe.
   */

  const requestedSlug =
    cleanText(teamName)
      .replace(/\s+/g, "-");

  const slugMatches =
    unique.filter(team => {
      return cleanText(team.slug) === requestedSlug;
    });

  if (slugMatches.length === 1) {
    return slugMatches[0];
  }

  throw new Error(
    `Équipe "${teamName}" non identifiée de manière suffisamment sûre.`
  );
}


// ============================================================
// EXTRACTION DU CALENDRIER
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

  const matches =
    extractMatches(data);

  return {
    raw: data,
    matches
  };
}


// ============================================================
// DIAGNOSTIC STRUCTURE
// ============================================================

function printObjectKeys(object, prefix = "") {
  if (
    object === null ||
    object === undefined ||
    typeof object !== "object"
  ) {
    return;
  }

  if (Array.isArray(object)) {
    console.log(
      `${prefix}[tableau de ${object.length} élément(s)]`
    );

    if (object.length > 0) {
      printObjectKeys(
        object[0],
        `${prefix}[0].`
      );
    }

    return;
  }

  for (const key of Object.keys(object)) {
    const value = object[key];

    if (
      value !== null &&
      typeof value === "object"
    ) {
      console.log(
        `${prefix}${key}: objet`
      );
    } else {
      console.log(
        `${prefix}${key}: ${JSON.stringify(value)}`
      );
    }
  }
}


function printRawMatch(label, match) {
  console.log("\n========================================");
  console.log(`🔬 MATCH BRUT — ${label}`);
  console.log("========================================");

  if (!match) {
    console.log("❌ Aucun match disponible.");
    return;
  }

  console.log("\n📌 CLÉS DISPONIBLES");
  console.log("----------------------------------------");

  printObjectKeys(match);

  console.log("\n📦 OBJET JSON COMPLET");
  console.log("----------------------------------------");

  const json =
    JSON.stringify(
      match,
      null,
      2
    );

  /*
   * Limite volontaire pour éviter de produire
   * plusieurs dizaines de milliers de lignes
   * dans GitHub Actions.
   */

  console.log(
    json.length > 12000
      ? json.slice(0, 12000) +
        "\n\n...[JSON tronqué à 12 000 caractères]..."
      : json
  );
}


// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================

async function main() {
  console.log("========================================");
  console.log(" BATBOT — DIAGNOSTIC SPORTScore");
  console.log("========================================");

  console.log("\nMatch testé :");
  console.log(
    `${HOME_TEAM_NAME} vs ${AWAY_TEAM_NAME}`
  );

  console.log("\n🔎 Recherche des équipes...");

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

  const homeSchedule =
    await fetchTeamSchedule(
      homeTeam
    );

  const awaySchedule =
    await fetchTeamSchedule(
      awayTeam
    );

  console.log(
    `Matchs récupérés domicile : ${homeSchedule.matches.length}`
  );

  console.log(
    `Matchs récupérés extérieur : ${awaySchedule.matches.length}`
  );

  /*
   * Nous affichons maintenant la structure exacte
   * reçue par SportScore.
   */

  printRawMatch(
    "REAL MADRID",
    homeSchedule.matches[0]
  );

  printRawMatch(
    "FC BARCELONA",
    awaySchedule.matches[0]
  );

  console.log("\n========================================");
  console.log(" ✅ DIAGNOSTIC TERMINÉ");
  console.log("========================================");

  console.log(
    "\n⚠️ Cette version ne calcule volontairement"
  );

  console.log(
    "pas encore les probabilités ni les cotes."
  );

  console.log(
    "Elle sert à identifier précisément les champs"
  );

  console.log(
    "de statut et de score retournés par SportScore."
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

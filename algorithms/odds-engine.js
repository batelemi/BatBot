/**
 * BATBOT — moteur statistique de calcul des cotes
 *
 * Version : poisson-v2
 *
 * Fonctionnement :
 *
 * statistiques récentes des équipes
 *          ↓
 * statistiques domicile / extérieur
 *          ↓
 * attaque + défense adversaire
 *          ↓
 * buts attendus
 *          ↓
 * modèle de Poisson
 *          ↓
 * matrice des scores
 *          ↓
 * probabilités
 *          ↓
 * cotes théoriques
 */

"use strict";

const MAX_GOALS = 10;
const MIN_MATCHES = 5;
const MIN_SPLIT_MATCHES = 3;

/**
 * Calcule la probabilité d'obtenir exactement
 * "goals" buts avec une loi de Poisson.
 */
function poissonProbability(lambda, goals) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new TypeError(
      "lambda doit être positif ou nul."
    );
  }

  if (!Number.isInteger(goals) || goals < 0) {
    throw new TypeError(
      "Le nombre de buts doit être un entier positif ou nul."
    );
  }

  let factorial = 1;

  for (let i = 2; i <= goals; i += 1) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial
  );
}

/**
 * Transforme une probabilité en cote théorique.
 */
function probabilityToOdds(probability) {
  if (!(probability > 0)) {
    return null;
  }

  return Number(
    (1 / probability).toFixed(2)
  );
}

/**
 * Sécurise une moyenne statistique.
 */
function safeAverage(total, matches) {
  if (
    !Number.isFinite(total) ||
    !Number.isFinite(matches) ||
    matches <= 0
  ) {
    return null;
  }

  return total / matches;
}

/**
 * Retourne les statistiques globales
 * d'une équipe.
 */
function getGlobalStats(team) {
  const matches = Number(team?.matches);

  if (!(matches > 0)) {
    return null;
  }

  const goalsFor = Number(team?.goalsFor);
  const goalsAgainst = Number(team?.goalsAgainst);

  if (
    !Number.isFinite(goalsFor) ||
    !Number.isFinite(goalsAgainst)
  ) {
    return null;
  }

  return {
    matches,
    goalsFor,
    goalsAgainst,
    averageGoalsFor:
      safeAverage(goalsFor, matches),
    averageGoalsAgainst:
      safeAverage(goalsAgainst, matches)
  };
}

/**
 * Retourne les statistiques domicile
 * d'une équipe.
 */
function getHomeStats(team) {
  const matches = Number(team?.homeMatches);

  if (!(matches > 0)) {
    return null;
  }

  const goalsFor =
    Number(team?.homeGoalsFor);

  const goalsAgainst =
    Number(team?.homeGoalsAgainst);

  if (
    !Number.isFinite(goalsFor) ||
    !Number.isFinite(goalsAgainst)
  ) {
    return null;
  }

  return {
    matches,
    goalsFor,
    goalsAgainst,
    averageGoalsFor:
      safeAverage(goalsFor, matches),
    averageGoalsAgainst:
      safeAverage(goalsAgainst, matches)
  };
}

/**
 * Retourne les statistiques extérieur
 * d'une équipe.
 */
function getAwayStats(team) {
  const matches = Number(team?.awayMatches);

  if (!(matches > 0)) {
    return null;
  }

  const goalsFor =
    Number(team?.awayGoalsFor);

  const goalsAgainst =
    Number(team?.awayGoalsAgainst);

  if (
    !Number.isFinite(goalsFor) ||
    !Number.isFinite(goalsAgainst)
  ) {
    return null;
  }

  return {
    matches,
    goalsFor,
    goalsAgainst,
    averageGoalsFor:
      safeAverage(goalsFor, matches),
    averageGoalsAgainst:
      safeAverage(goalsAgainst, matches)
  };
}

/**
 * Choisit les statistiques adaptées
 * au contexte du match.
 *
 * Équipe à domicile :
 *   attaque domicile
 *   défense domicile
 *
 * Équipe à l'extérieur :
 *   attaque extérieur
 *   défense extérieur
 *
 * Si l'échantillon domicile/extérieur
 * est trop faible, on utilise les statistiques
 * globales de l'équipe.
 */
function selectContextStats(team, context) {
  const global = getGlobalStats(team);

  if (!global) {
    return null;
  }

  if (
    context === "home" &&
    Number(team?.homeMatches) >= MIN_SPLIT_MATCHES
  ) {
    return getHomeStats(team) || global;
  }

  if (
    context === "away" &&
    Number(team?.awayMatches) >= MIN_SPLIT_MATCHES
  ) {
    return getAwayStats(team) || global;
  }

  return global;
}

/**
 * Calcule les buts attendus.
 *
 * Pour l'équipe à domicile :
 *
 * attaque domicile de l'équipe
 * +
 * défense extérieur de l'adversaire
 *
 * Pour l'équipe extérieure :
 *
 * attaque extérieur de l'équipe
 * +
 * défense domicile de l'adversaire
 *
 * Le modèle utilise une moyenne des deux
 * composantes afin d'éviter de dépendre
 * d'une seule statistique.
 */
function calculateExpectedGoals(home, away) {
  if (
    !home ||
    !away ||
    Number(home.matches) < MIN_MATCHES ||
    Number(away.matches) < MIN_MATCHES
  ) {
    return {
      sufficientData: false,
      reason:
        `Au moins ${MIN_MATCHES} matchs terminés avec score ` +
        `sont nécessaires pour chaque équipe.`
    };
  }

  const homeContext =
    selectContextStats(home, "home");

  const awayContext =
    selectContextStats(away, "away");

  const homeOpponentContext =
    selectContextStats(away, "away");

  const awayOpponentContext =
    selectContextStats(home, "home");

  if (
    !homeContext ||
    !awayContext ||
    !homeOpponentContext ||
    !awayOpponentContext
  ) {
    return {
      sufficientData: false,
      reason:
        "Les statistiques nécessaires au calcul sont insuffisantes."
    };
  }

  const homeAttack =
    homeContext.averageGoalsFor;

  const homeDefense =
    homeContext.averageGoalsAgainst;

  const awayAttack =
    awayContext.averageGoalsFor;

  const awayDefense =
    awayContext.averageGoalsAgainst;

  /*
   * Attaque de l'équipe à domicile
   * confrontée à la défense de l'équipe extérieure.
   */
  const homeExpected =
    (homeAttack + awayDefense) / 2;

  /*
   * Attaque de l'équipe extérieure
   * confrontée à la défense de l'équipe à domicile.
   */
  const awayExpected =
    (awayAttack + homeDefense) / 2;

  return {
    sufficientData: true,

    homeExpected: Math.max(
      0.05,
      Math.min(5, homeExpected)
    ),

    awayExpected: Math.max(
      0.05,
      Math.min(5, awayExpected)
    ),

    context: {
      homeAttackMatches:
        homeContext.matches,

      homeDefenseMatches:
        homeContext.matches,

      awayAttackMatches:
        awayContext.matches,

      awayDefenseMatches:
        awayContext.matches
    }
  };
}

/**
 * Construit la matrice complète
 * des probabilités de scores.
 */
function buildScoreMatrix(
  homeExpected,
  awayExpected
) {
  const matrix = [];

  let totalProbability = 0;

  for (
    let homeGoals = 0;
    homeGoals <= MAX_GOALS;
    homeGoals += 1
  ) {
    const row = [];

    for (
      let awayGoals = 0;
      awayGoals <= MAX_GOALS;
      awayGoals += 1
    ) {
      const probability =
        poissonProbability(
          homeExpected,
          homeGoals
        ) *
        poissonProbability(
          awayExpected,
          awayGoals
        );

      row.push(probability);
      totalProbability += probability;
    }

    matrix.push(row);
  }

  /*
   * La matrice est limitée à 0–10 buts.
   *
   * On renormalise afin que toutes les probabilités
   * de marché reposent sur une masse totale de 100 %.
   */
  if (totalProbability > 0) {
    for (
      let h = 0;
      h <= MAX_GOALS;
      h += 1
    ) {
      for (
        let a = 0;
        a <= MAX_GOALS;
        a += 1
      ) {
        matrix[h][a] =
          matrix[h][a] /
          totalProbability;
      }
    }
  }

  return matrix;
}

/**
 * Calcule les différents marchés.
 */
function calculateMarkets(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;

  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  let btts = 0;

  let bestScore = {
    homeGoals: 0,
    awayGoals: 0,
    probability: 0
  };

  for (
    let h = 0;
    h <= MAX_GOALS;
    h += 1
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a += 1
    ) {
      const probability =
        matrix[h][a];

      if (h > a) {
        home += probability;
      } else if (h === a) {
        draw += probability;
      } else {
        away += probability;
      }

      if (h + a >= 2) {
        over15 += probability;
      }

      if (h + a >= 3) {
        over25 += probability;
      }

      if (h + a >= 4) {
        over35 += probability;
      }

      if (h > 0 && a > 0) {
        btts += probability;
      }

      if (
        probability >
        bestScore.probability
      ) {
        bestScore = {
          homeGoals: h,
          awayGoals: a,
          probability
        };
      }
    }
  }

  return {
    home,
    draw,
    away,

    over15,
    over25,
    over35,

    under25:
      1 - over25,

    under35:
      1 - over35,

    bttsYes:
      btts,

    bttsNo:
      1 - btts,

    bestScore
  };
}

/**
 * Normalise les probabilités 1X2.
 */
function normalize(home, draw, away) {
  const total =
    home +
    draw +
    away;

  if (!(total > 0)) {
    throw new Error(
      "Probabilités invalides."
    );
  }

  return {
    home:
      home / total,

    draw:
      draw / total,

    away:
      away / total
  };
}

/**
 * Formate un marché.
 */
function formatMarket(probability) {
  return {
    probability:
      Number(
        (probability * 100)
          .toFixed(2)
      ),

    theoreticalOdds:
      probabilityToOdds(
        probability
      )
  };
}

/**
 * Fonction principale du moteur.
 */
function calculateOdds(input) {
  const home =
    input?.home;

  const away =
    input?.away;

  if (!home || !away) {
    throw new TypeError(
      "Les statistiques des deux équipes sont obligatoires."
    );
  }

  const expected =
    calculateExpectedGoals(
      home,
      away
    );

  if (
    !expected.sufficientData
  ) {
    return expected;
  }

  const matrix =
    buildScoreMatrix(
      expected.homeExpected,
      expected.awayExpected
    );

  const markets =
    calculateMarkets(
      matrix
    );

  const probabilities =
    normalize(
      markets.home,
      markets.draw,
      markets.away
    );

  return {
    sufficientData: true,

    model:
      "poisson-v2-home-away",

    expectedGoals: {
      home:
        Number(
          expected.homeExpected
            .toFixed(3)
        ),

      away:
        Number(
          expected.awayExpected
            .toFixed(3)
        )
    },

    context: expected.context,

    oneXTwo: {
      home:
        formatMarket(
          probabilities.home
        ),

      draw:
        formatMarket(
          probabilities.draw
        ),

      away:
        formatMarket(
          probabilities.away
        )
    },

    markets: {
      "1X":
        formatMarket(
          probabilities.home +
          probabilities.draw
        ),

      "X2":
        formatMarket(
          probabilities.draw +
          probabilities.away
        ),

      "12":
        formatMarket(
          probabilities.home +
          probabilities.away
        ),

      over15:
        formatMarket(
          markets.over15
        ),

      over25:
        formatMarket(
          markets.over25
        ),

      over35:
        formatMarket(
          markets.over35
        ),

      under25:
        formatMarket(
          markets.under25
        ),

      under35:
        formatMarket(
          markets.under35
        ),

      bttsYes:
        formatMarket(
          markets.bttsYes
        ),

      bttsNo:
        formatMarket(
          markets.bttsNo
        )
    },

    mostLikelyScore: {
      score:
        `${markets.bestScore.homeGoals}-${markets.bestScore.awayGoals}`,

      probability:
        Number(
          (
            markets.bestScore
              .probability *
            100
          ).toFixed(2)
        )
    },

    probabilityCheck:
      Number(
        (
          probabilities.home +
          probabilities.draw +
          probabilities.away
        ).toFixed(6)
      )
  };
}

module.exports = {
  calculateOdds,
  calculateExpectedGoals,
  poissonProbability,
  probabilityToOdds,
  MIN_MATCHES,
  MAX_GOALS
};

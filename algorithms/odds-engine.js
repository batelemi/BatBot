/**
 * BATBOT — moteur statistique de calcul des cotes
 *
 * Fichier indépendant.
 * Cette première version n'est pas connectée à l'application.
 *
 * Fonctionnement :
 * données statistiques
 *      ↓
 * buts attendus
 *      ↓
 * modèle de Poisson
 *      ↓
 * probabilités 1X2
 *      ↓
 * cotes théoriques
 */

"use strict";

const MAX_GOALS = 10;
const MIN_MATCHES = 5;

function poissonProbability(lambda, goals) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new TypeError("lambda doit être positif ou nul.");
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

function probabilityToOdds(probability) {
  if (!(probability > 0)) {
    return null;
  }

  return Number((1 / probability).toFixed(2));
}

function normalize(home, draw, away) {
  const total = home + draw + away;

  if (!(total > 0)) {
    throw new Error("Probabilités invalides.");
  }

  return {
    home: home / total,
    draw: draw / total,
    away: away / total
  };
}

function calculateExpectedGoals(home, away) {
  if (
    !home ||
    !away ||
    home.matches < MIN_MATCHES ||
    away.matches < MIN_MATCHES
  ) {
    return {
      sufficientData: false,
      reason:
        `Au moins ${MIN_MATCHES} matchs terminés avec score ` +
        `sont nécessaires pour chaque équipe.`
    };
  }

  const homeAttack =
    home.goalsFor / home.matches;

  const homeDefense =
    home.goalsAgainst / home.matches;

  const awayAttack =
    away.goalsFor / away.matches;

  const awayDefense =
    away.goalsAgainst / away.matches;

  /*
   * Mélange attaque de l'équipe
   * et défense de l'adversaire.
   *
   * Léger facteur domicile.
   */
  const homeExpected =
    ((homeAttack + awayDefense) / 2) * 1.05;

  const awayExpected =
    ((awayAttack + homeDefense) / 2) * 0.95;

  return {
    sufficientData: true,
    homeExpected: Math.max(
      0.05,
      Math.min(5, homeExpected)
    ),
    awayExpected: Math.max(
      0.05,
      Math.min(5, awayExpected)
    )
  };
}

function buildScoreMatrix(homeExpected, awayExpected) {
  const matrix = [];

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
        poissonProbability(homeExpected, homeGoals) *
        poissonProbability(awayExpected, awayGoals);

      row.push(probability);
    }

    matrix.push(row);
  }

  return matrix;
}

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

  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const probability = matrix[h][a];

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

      if (probability > bestScore.probability) {
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
    under25: 1 - over25,
    under35: 1 - over35,
    bttsYes: btts,
    bttsNo: 1 - btts,
    bestScore
  };
}

function formatMarket(probability) {
  return {
    probability: Number(
      (probability * 100).toFixed(2)
    ),
    theoreticalOdds: probabilityToOdds(probability)
  };
}

function calculateOdds(input) {
  const home = input?.home;
  const away = input?.away;

  if (!home || !away) {
    throw new TypeError(
      "Les statistiques des deux équipes sont obligatoires."
    );
  }

  const expected =
    calculateExpectedGoals(home, away);

  if (!expected.sufficientData) {
    return expected;
  }

  const matrix = buildScoreMatrix(
    expected.homeExpected,
    expected.awayExpected
  );

  const markets =
    calculateMarkets(matrix);

  const probabilities =
    normalize(
      markets.home,
      markets.draw,
      markets.away
    );

  return {
    sufficientData: true,

    model: "poisson-v1",

    expectedGoals: {
      home: Number(
        expected.homeExpected.toFixed(3)
      ),
      away: Number(
        expected.awayExpected.toFixed(3)
      )
    },

    oneXTwo: {
      home: formatMarket(
        probabilities.home
      ),

      draw: formatMarket(
        probabilities.draw
      ),

      away: formatMarket(
        probabilities.away
      )
    },

    markets: {
      "1X": formatMarket(
        probabilities.home +
        probabilities.draw
      ),

      "X2": formatMarket(
        probabilities.draw +
        probabilities.away
      ),

      "12": formatMarket(
        probabilities.home +
        probabilities.away
      ),

      over15: formatMarket(
        markets.over15
      ),

      over25: formatMarket(
        markets.over25
      ),

      over35: formatMarket(
        markets.over35
      ),

      under25: formatMarket(
        markets.under25
      ),

      under35: formatMarket(
        markets.under35
      ),

      bttsYes: formatMarket(
        markets.bttsYes
      ),

      bttsNo: formatMarket(
        markets.bttsNo
      )
    },

    mostLikelyScore: {
      score:
        `${markets.bestScore.homeGoals}-${markets.bestScore.awayGoals}`,

      probability: Number(
        (markets.bestScore.probability * 100)
          .toFixed(2)
      )
    },

    probabilityCheck: Number(
      (
        probabilities.home +
        probabilities.draw +
        probabilities.away
      )
      .toFixed(6)
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

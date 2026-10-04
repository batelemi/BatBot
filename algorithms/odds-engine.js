/**
 * BATBOT — moteur statistique de calcul des cotes
 *
 * Version : poisson-v3
 *
 * Objectif :
 * Construire des probabilités à partir des statistiques récentes
 * tout en évitant qu'un petit échantillon domicile/extérieur
 * domine excessivement le calcul.
 *
 * Fonctionnement :
 *
 * statistiques globales
 *        +
 * statistiques domicile / extérieur
 *        ↓
 * pondération selon la taille de l'échantillon
 *        ↓
 * attaque + défense adverse
 *        ↓
 * buts attendus
 *        ↓
 * modèle de Poisson
 *        ↓
 * probabilités
 *        ↓
 * cotes théoriques
 */

"use strict";

const MAX_GOALS = 10;
const MIN_MATCHES = 5;
const MIN_SPLIT_MATCHES = 3;

/*
 * Valeur utilisée pour réduire l'influence d'un petit
 * échantillon contextuel.
 *
 * Plus le nombre de matchs contextuels augmente,
 * plus la statistique domicile/extérieur prend du poids.
 *
 * Exemple :
 *
 * 3 matchs  → 37.5 %
 * 4 matchs  → 44.4 %
 * 5 matchs  → 50.0 %
 * 10 matchs → 66.7 %
 *
 * Le reste du poids revient aux statistiques globales.
 */
const CONTEXT_PRIOR_MATCHES = 5;


// ============================================================
// POISSON
// ============================================================

function poissonProbability(lambda, goals) {
  if (
    !Number.isFinite(lambda) ||
    lambda < 0
  ) {
    throw new TypeError(
      "lambda doit être positif ou nul."
    );
  }

  if (
    !Number.isInteger(goals) ||
    goals < 0
  ) {
    throw new TypeError(
      "Le nombre de buts doit être un entier positif ou nul."
    );
  }

  let factorial = 1;

  for (
    let i = 2;
    i <= goals;
    i += 1
  ) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial
  );
}


// ============================================================
// PROBABILITÉ → COTE
// ============================================================

function probabilityToOdds(probability) {
  if (!(probability > 0)) {
    return null;
  }

  return Number(
    (1 / probability).toFixed(2)
  );
}


// ============================================================
// MOYENNE SÉCURISÉE
// ============================================================

function safeAverage(
  total,
  matches
) {
  if (
    !Number.isFinite(total) ||
    !Number.isFinite(matches) ||
    matches <= 0
  ) {
    return null;
  }

  return total / matches;
}


// ============================================================
// STATISTIQUES GLOBALES
// ============================================================

function getGlobalStats(team) {
  const matches =
    Number(team?.matches);

  if (!(matches > 0)) {
    return null;
  }

  const goalsFor =
    Number(team?.goalsFor);

  const goalsAgainst =
    Number(team?.goalsAgainst);

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
      safeAverage(
        goalsFor,
        matches
      ),

    averageGoalsAgainst:
      safeAverage(
        goalsAgainst,
        matches
      )
  };
}


// ============================================================
// STATISTIQUES DOMICILE
// ============================================================

function getHomeStats(team) {
  const matches =
    Number(team?.homeMatches);

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
      safeAverage(
        goalsFor,
        matches
      ),

    averageGoalsAgainst:
      safeAverage(
        goalsAgainst,
        matches
      )
  };
}


// ============================================================
// STATISTIQUES EXTÉRIEUR
// ============================================================

function getAwayStats(team) {
  const matches =
    Number(team?.awayMatches);

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
      safeAverage(
        goalsFor,
        matches
      ),

    averageGoalsAgainst:
      safeAverage(
        goalsAgainst,
        matches
      )
  };
}


// ============================================================
// POIDS CONTEXTUEL
// ============================================================

function calculateContextWeight(
  contextMatches
) {
  const matches =
    Number(contextMatches);

  if (
    !Number.isFinite(matches) ||
    matches < MIN_SPLIT_MATCHES
  ) {
    return 0;
  }

  const weight =
    matches /
    (
      matches +
      CONTEXT_PRIOR_MATCHES
    );

  return Math.max(
    0,
    Math.min(
      1,
      weight
    )
  );
}


// ============================================================
// MÉLANGE GLOBAL + CONTEXTUEL
// ============================================================

function blendValue(
  globalValue,
  contextualValue,
  contextualMatches
) {
  if (
    !Number.isFinite(globalValue)
  ) {
    return contextualValue;
  }

  if (
    !Number.isFinite(contextualValue)
  ) {
    return globalValue;
  }

  const contextWeight =
    calculateContextWeight(
      contextualMatches
    );

  const globalWeight =
    1 - contextWeight;

  return (
    globalValue *
    globalWeight
    +
    contextualValue *
    contextWeight
  );
}


// ============================================================
// SÉLECTION DES STATISTIQUES CONTEXTUELLES
// ============================================================

function getBlendedContextStats(
  team,
  context
) {
  const global =
    getGlobalStats(team);

  if (!global) {
    return null;
  }

  let contextual = null;

  if (
    context === "home"
  ) {
    contextual =
      getHomeStats(team);
  }

  if (
    context === "away"
  ) {
    contextual =
      getAwayStats(team);
  }

  /*
   * Aucun échantillon contextuel suffisant :
   * on utilise uniquement les statistiques globales.
   */
  if (
    !contextual ||
    contextual.matches <
      MIN_SPLIT_MATCHES
  ) {
    return {
      matches:
        global.matches,

      averageGoalsFor:
        global.averageGoalsFor,

      averageGoalsAgainst:
        global.averageGoalsAgainst,

      contextualMatches: 0,

      contextualWeight: 0,

      globalWeight: 1,

      source:
        "global"
    };
  }

  const contextualWeight =
    calculateContextWeight(
      contextual.matches
    );

  const globalWeight =
    1 -
    contextualWeight;

  const averageGoalsFor =
    blendValue(
      global.averageGoalsFor,
      contextual.averageGoalsFor,
      contextual.matches
    );

  const averageGoalsAgainst =
    blendValue(
      global.averageGoalsAgainst,
      contextual.averageGoalsAgainst,
      contextual.matches
    );

  return {
    matches:
      global.matches,

    averageGoalsFor,

    averageGoalsAgainst,

    contextualMatches:
      contextual.matches,

    contextualWeight,

    globalWeight,

    source:
      "global+context"
  };
}


// ============================================================
// BUTS ATTENDUS
// ============================================================

function calculateExpectedGoals(
  home,
  away
) {
  if (
    !home ||
    !away ||
    Number(home.matches) <
      MIN_MATCHES ||
    Number(away.matches) <
      MIN_MATCHES
  ) {
    return {
      sufficientData: false,

      reason:
        `Au moins ${MIN_MATCHES} matchs terminés avec score ` +
        `sont nécessaires pour chaque équipe.`
    };
  }

  /*
   * L'équipe à domicile :
   *
   * attaque domicile pondérée
   * +
   * défense extérieure de l'adversaire pondérée
   */
  const homeContext =
    getBlendedContextStats(
      home,
      "home"
    );

  const awayContext =
    getBlendedContextStats(
      away,
      "away"
    );

  /*
   * Les deux mêmes statistiques sont également
   * utilisées pour décrire la défense adverse.
   */
  if (
    !homeContext ||
    !awayContext
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
   * Buts attendus :
   *
   * L'ancienne version utilisait une moyenne arithmétique :
   *
   *   (attaque + défense adverse) / 2
   *
   * Cette formule pouvait gonfler les buts attendus lorsqu'une
   * équipe avait une moyenne offensive très élevée ou que la
   * défense adverse avait encaissé beaucoup de buts.
   *
   * On utilise désormais une moyenne géométrique. Elle conserve
   * l'information des deux composantes tout en limitant l'effet
   * d'une valeur extrême :
   *
   *   sqrt(attaque × défense adverse)
   *
   * Si l'une des valeurs est nulle ou invalide, on revient à une
   * moyenne arithmétique sûre.
   */
  function combineAttackAndDefense(attack, opponentDefense) {
    const a = Number(attack);
    const d = Number(opponentDefense);

    if (Number.isFinite(a) && Number.isFinite(d) && a > 0 && d > 0) {
      return Math.sqrt(a * d);
    }

    if (Number.isFinite(a) && Number.isFinite(d)) {
      return Math.max(0.05, (a + d) / 2);
    }

    return 0.05;
  }

  const homeExpected =
    combineAttackAndDefense(
      homeAttack,
      awayDefense
    );

  const awayExpected =
    combineAttackAndDefense(
      awayAttack,
      homeDefense
    );

  return {
    sufficientData: true,

    homeExpected:
      Math.max(
        0.05,
        Math.min(
          5,
          homeExpected
        )
      ),

    awayExpected:
      Math.max(
        0.05,
        Math.min(
          5,
          awayExpected
        )
      ),

    context: {
      home: {
        source:
          homeContext.source,

        contextualMatches:
          homeContext.contextualMatches,

        contextualWeight:
          Number(
            (
              homeContext.contextualWeight *
              100
            ).toFixed(2)
          ),

        globalWeight:
          Number(
            (
              homeContext.globalWeight *
              100
            ).toFixed(2)
          )
      },

      away: {
        source:
          awayContext.source,

        contextualMatches:
          awayContext.contextualMatches,

        contextualWeight:
          Number(
            (
              awayContext.contextualWeight *
              100
            ).toFixed(2)
          ),

        globalWeight:
          Number(
            (
              awayContext.globalWeight *
              100
            ).toFixed(2)
          )
      }
    }
  };
}


// ============================================================
// MATRICE DES SCORES
// ============================================================

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

      row.push(
        probability
      );

      totalProbability +=
        probability;
    }

    matrix.push(row);
  }

  /*
   * Les scores sont limités à 0–10 buts.
   *
   * On renormalise la matrice pour que
   * la masse de probabilité soit exactement
   * exploitée à 100 % dans les marchés.
   */
  if (
    totalProbability > 0
  ) {
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


// ============================================================
// MARCHÉS
// ============================================================

function getCompatibleBestScore(matrix, preferredResult) {
  let best = { homeGoals: 0, awayGoals: 0, probability: 0 };
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const probability = matrix[h][a];
      const compatible = preferredResult === "home" ? h > a : preferredResult === "away" ? a > h : h === a;
      if (compatible && probability > best.probability) best = { homeGoals: h, awayGoals: a, probability };
    }
  }
  return best;
}

function calculateMarkets(
  matrix
) {
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

      if (
        h > a
      ) {
        home +=
          probability;
      } else if (
        h === a
      ) {
        draw +=
          probability;
      } else {
        away +=
          probability;
      }

      /*
       * Over 1.5
       */
      if (
        h + a >= 2
      ) {
        over15 +=
          probability;
      }

      /*
       * Over 2.5
       */
      if (
        h + a >= 3
      ) {
        over25 +=
          probability;
      }

      /*
       * Over 3.5
       */
      if (
        h + a >= 4
      ) {
        over35 +=
          probability;
      }

      /*
       * Both Teams To Score
       */
      if (
        h > 0 &&
        a > 0
      ) {
        btts +=
          probability;
      }

    }
  }

  const preferredResult =
    home >= draw && home >= away
      ? "home"
      : away >= home && away >= draw
        ? "away"
        : "draw";

  bestScore = getCompatibleBestScore(
    matrix,
    preferredResult
  );

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


// ============================================================
// NORMALISATION 1X2
// ============================================================

function normalize(
  home,
  draw,
  away
) {
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


// ============================================================
// FORMATAGE DES MARCHÉS
// ============================================================

function formatMarket(
  probability
) {
  return {
    probability:
      Number(
        (
          probability *
          100
        ).toFixed(2)
      ),

    theoreticalOdds:
      probabilityToOdds(
        probability
      )
  };
}


// ============================================================
// MOTEUR PRINCIPAL
// ============================================================

function calculateOdds(
  input
) {
  const home =
    input?.home;

  const away =
    input?.away;

  if (
    !home ||
    !away
  ) {
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
    sufficientData:
      true,

    model:
      "poisson-v3-weighted-home-away-geometric",

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

    context:
      expected.context,

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
            markets.bestScore.probability *
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


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  calculateOdds,

  calculateExpectedGoals,

  poissonProbability,

  probabilityToOdds,

  MIN_MATCHES,

  MIN_SPLIT_MATCHES,

  MAX_GOALS,

  CONTEXT_PRIOR_MATCHES
};

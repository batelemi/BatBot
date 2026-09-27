"use strict";

const {
  calculateOdds
} = require("./odds-engine");

console.log("========================================");
console.log(" BATBOT — TEST DU MOTEUR DE COTES");
console.log("========================================");

const result = calculateOdds({
  home: {
    matches: 8,
    goalsFor: 12,
    goalsAgainst: 8
  },

  away: {
    matches: 8,
    goalsFor: 9,
    goalsAgainst: 10
  }
});

console.log("\n📊 RÉSULTAT DU MODÈLE");
console.log("----------------------------------------");

if (!result.sufficientData) {
  console.log("❌ Données insuffisantes");
  console.log(result.reason);
  process.exit(1);
}

console.log(
  "Buts attendus domicile :",
  result.expectedGoals.home
);

console.log(
  "Buts attendus extérieur :",
  result.expectedGoals.away
);

console.log("\n⚽ PROBABILITÉS 1X2");
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

console.log("\n🔎 CONTRÔLE 1X2");
console.log("----------------------------------------");

const total =
  result.oneXTwo.home.probability +
  result.oneXTwo.draw.probability +
  result.oneXTwo.away.probability;

console.log(
  "Total :",
  total.toFixed(2) + "%"
);

if (Math.abs(total - 100) < 0.01) {
  console.log("✅ Les probabilités totalisent 100 %");
} else {
  console.log("❌ ERREUR : les probabilités ne totalisent pas 100 %");
  process.exit(1);
}

console.log("\n🎯 SCORE LE PLUS PROBABLE");
console.log("----------------------------------------");

console.log(
  result.mostLikelyScore.score,
  "—",
  result.mostLikelyScore.probability + "%"
);

console.log("\n📈 AUTRES MARCHÉS");
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

console.log("\n========================================");
console.log(" ✅ TEST DU MOTEUR TERMINÉ");
console.log("========================================");

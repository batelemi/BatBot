const assert = require("node:assert/strict");
const { isEligibleCurrentFixture } =
  require("./sportscore-odds-service");

const now = Date.now();

function fixture(status, dateOffsetMs, goals = null) {
  const match = {
    home: "Équipe A",
    away: "Équipe B",
    date: new Date(now + dateOffsetMs).toISOString(),
    status
  };

  if (goals) match.goals = goals;
  return match;
}

const cases = [
  ["match à venir NS", fixture("NS", 60_000), true],
  ["match à venir scheduled", fixture("scheduled", 60_000), true],
  ["match en direct", fixture("LIVE", -60_000), true],
  ["match terminé FT", fixture("FT", -60_000, { home: 2, away: 1 }), false],
  ["statut ambigu futur", fixture("UNKNOWN", 60_000), false],
  ["statut ambigu passé sans score", fixture("UNKNOWN", -60_000), false],
  ["tirs au but passés avec score", fixture("penalties", -60_000, { home: 1, away: 1 }), false],
  ["match programmé mais date passée", fixture("NS", -60_000), false]
];

let failed = 0;

for (const [label, input, expected] of cases) {
  try {
    assert.equal(isEligibleCurrentFixture(input), expected);
    console.log("OK  - " + label);
  } catch (error) {
    failed++;
    console.error("ÉCHEC - " + label + ": " + error.message);
  }
}

if (failed) {
  console.error(`\n${failed} test(s) en échec.`);
  process.exitCode = 1;
} else {
  console.log(`\n${cases.length}/${cases.length} tests réussis.`);
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function subtractUtcDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() - days);
  return copy;
}

async function fetchTeamSchedule(team) {
  const collected = [];
  const seen = new Set();

  const MAX_LOOKBACK_DAYS = 180;
  const TARGET_MATCHES = 10;

  const today = new Date();

  console.log(
    `\n📅 Recherche de l'historique récent de ${team.name}...`
  );

  for (
    let daysAgo = 0;
    daysAgo < MAX_LOOKBACK_DAYS;
    daysAgo++
  ) {
    const date = subtractUtcDays(
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
        `⚠️ Erreur SportScore pour ${team.name} le ${dateText}:`,
        error.message
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

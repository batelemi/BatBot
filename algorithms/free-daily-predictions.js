'use strict';

const DAILY_STATE_KEY = 'batbot_free_daily_predictions_v1';
const DAILY_LOCK_ID = 728451903;
const MAX_DAILY_PICKS = 10;
const MIN_DAILY_PICKS = 5;

let databasePool = null;

function getAbidjanDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Abidjan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getNextDate(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function getAbidjanMidnight(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

async function initializeFreeDailyPredictions(pool) {
  if (
    !pool ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function'
  ) {
    throw new Error('Connexion PostgreSQL invalide pour les pronostics collectifs.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS batbot_free_daily_state (
      state_key TEXT PRIMARY KEY,
      prepared_for DATE,
      prepared_picks JSONB NOT NULL DEFAULT '[]'::jsonb,
      published_for DATE,
      published_picks JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO batbot_free_daily_state (state_key)
    VALUES ($1)
    ON CONFLICT (state_key) DO NOTHING
  `, [DAILY_STATE_KEY]);

  databasePool = pool;

  console.log('BATBOT : stockage des pronostics collectifs initialisé.');
}

async function withDailyLock(callback) {
  if (!databasePool) {
    throw new Error('Service des pronostics collectifs non initialisé.');
  }

  const client = await databasePool.connect();
  let locked = false;

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [DAILY_LOCK_ID]
    );

    locked = result.rows[0]?.locked === true;

    if (!locked) {
      return { skipped: true, reason: 'Une autre instance traite déjà les pronostics collectifs.' };
    }

    return await callback(client);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [DAILY_LOCK_ID]);
      } catch (error) {
        console.error('BATBOT : erreur de libération du verrou collectif :', error.message);
      }
    }

    client.release();
  }
}

async function savePreparedPicks(client, targetDate, picks) {
  if (!Array.isArray(picks)) {
    throw new Error('La préparation collective doit être une liste de pronostics.');
  }

  const result = await client.query(`
    UPDATE batbot_free_daily_state
    SET prepared_for = $2::date,
        prepared_picks = $3::jsonb,
        updated_at = NOW()
    WHERE state_key = $1
      AND prepared_for IS DISTINCT FROM $2::date
      AND published_for IS DISTINCT FROM $2::date
    RETURNING prepared_for
  `, [DAILY_STATE_KEY, targetDate, JSON.stringify(picks)]);

  if (result.rows.length) {
    return {
      prepared: true,
      alreadyPrepared: false,
      date: targetDate,
      picks
    };
  }

  const existing = await client.query(`
    SELECT
      CASE
        WHEN prepared_for = $2::date THEN prepared_picks
        WHEN published_for = $2::date THEN published_picks
      END AS picks,
      (published_for = $2::date) AS already_published
    FROM batbot_free_daily_state
    WHERE state_key = $1
      AND (prepared_for = $2::date OR published_for = $2::date)
  `, [DAILY_STATE_KEY, targetDate]);

  if (!existing.rows.length) {
    throw new Error(
      `Impossible de confirmer la préparation collective du ${targetDate}.`
    );
  }

  return {
    prepared: true,
    alreadyPrepared: true,
    alreadyPublished: existing.rows[0].already_published === true,
    date: targetDate,
    picks: existing.rows[0].picks || []
  };
}
async function publishPreparedPicks(client, targetDate) {
  const prepared = await client.query(`
    SELECT prepared_picks
    FROM batbot_free_daily_state
    WHERE state_key = $1
      AND prepared_for = $2::date
  `, [DAILY_STATE_KEY, targetDate]);

  if (!prepared.rows.length) {
    return {
      published: false,
      reason: 'Aucune préparation disponible pour cette date.'
    };
  }

  const picks = prepared.rows[0].prepared_picks;

  if (!Array.isArray(picks) || picks.length === 0) {
    return {
      published: false,
      empty: true,
      prepared: true,
      date: targetDate,
      picks: [],
      reason: 'Aucun pronostic admissible pour cette date.'
    };
  }

  const result = await client.query(`
    UPDATE batbot_free_daily_state
    SET published_for = prepared_for,
        published_picks = prepared_picks,
        prepared_for = NULL,
        prepared_picks = '[]'::jsonb,
        updated_at = NOW()
    WHERE state_key = $1
      AND prepared_for = $2::date
      AND published_for IS DISTINCT FROM $2::date
    RETURNING published_for, published_picks
  `, [DAILY_STATE_KEY, targetDate]);

  if (!result.rows.length) {
    return {
      published: false,
      reason: 'Aucune préparation disponible pour cette date.'
    };
  }

  return {
    published: true,
    date: result.rows[0].published_for,
    picks: result.rows[0].published_picks
  };
}

async function getActiveDailyPicks() {
  if (!databasePool) {
    throw new Error('Service des pronostics collectifs non initialisé.');
  }

  const today = getAbidjanDate();

  const result = await databasePool.query(`
    SELECT published_for, published_picks, updated_at
    FROM batbot_free_daily_state
    WHERE state_key = $1
      AND published_for = $2::date
  `, [DAILY_STATE_KEY, today]);

  if (!result.rows.length) {
    return {
      date: today,
      published: false,
      picks: []
    };
  }

  return {
    date: today,
    published: true,
    picks: result.rows[0].published_picks,
    updatedAt: result.rows[0].updated_at
  };
}

module.exports = {
  initializeFreeDailyPredictions,
  withDailyLock,
  savePreparedPicks,
  publishPreparedPicks,
  getActiveDailyPicks,
  getAbidjanDate,
  getNextDate,
  getAbidjanMidnight,
  MIN_DAILY_PICKS,
  MAX_DAILY_PICKS
};

const { fetchFixtures } = require('./sportapi-fixtures-service');
const { analyzeSportApiMatches } = require('./sportapi-odds-service');

async function prepareDailyPicks(targetDate) {
  return withDailyLock(async client => {
    const now = new Date();
    const start = targetDate === getAbidjanDate(now)
      ? now
      : getAbidjanMidnight(targetDate);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const dates = [targetDate];
    const lastIncludedMoment = new Date(end.getTime() - 1);

    if (getAbidjanDate(lastIncludedMoment) !== targetDate) {
      dates.push(getNextDate(targetDate));
    }

    const fixturesById = new Map();

    for (const date of dates) {
      const response = await fetchFixtures(date);

      for (const fixture of response.fixtures || []) {
        const kickoff = new Date(fixture?.fixture?.date || '');

        if (
          !Number.isFinite(kickoff.getTime()) ||
          kickoff < start ||
          kickoff >= end ||
          fixture?.fixture?.status?.short !== 'NS' ||
          !fixture?.teams?.home?.id ||
          !fixture?.teams?.away?.id
        ) {
          continue;
        }

        fixturesById.set(String(fixture.fixture.id), fixture);
      }
    }

    const candidates = [...fixturesById.values()]
      .sort((a, b) =>
        new Date(a.fixture.date).getTime() -
        new Date(b.fixture.date).getTime()
      );

    const qualified = [];

    for (let index = 0; index < candidates.length; index += 2) {
      const batch = candidates.slice(index, index + 2);

      try {
        const analysis = await analyzeSportApiMatches(batch);

        if (
          !analysis ||
          !Array.isArray(analysis.matches) ||
          analysis.matches.length !== batch.length
        ) {
          throw new Error(
            `Réponse d'analyse incomplète pour le lot de ${batch.length} match(s).`
          );
        }

        for (const result of analysis.matches) {
          const model = result.model || {};
          const code = model.recommendationCode;

          if (
            result.ready !== true ||
            result.sufficientData !== true ||
            !code ||
            !Array.isArray(model.options)
          ) {
            continue;
          }

          const selected = model.options.find(option =>
            option.code === code &&
            Number.isFinite(Number(option.probability)) &&
            Number(option.probability) >= 60 &&
            Number(option.probability) <= 85
          );

          if (!selected) continue;

          const fixture = result.fixture;
          const fixtureId = String(fixture?.fixture?.id || '');

          if (!fixtureId) continue;

          qualified.push({
            fixtureId,
            kickoff: fixture.fixture.date,
            league: {
              id: fixture.league?.id || null,
              name: fixture.league?.name || 'Compétition inconnue',
              emblem: fixture.league?.emblem || null
            },
            homeTeam: result.homeTeam,
            awayTeam: result.awayTeam,
            market: {
              code: selected.code,
              name: selected.name,
              probability: Number(selected.probability),
              risk: selected.risk || null
            },
            status: 'pending',
            score: null
          });
        }
      } catch (error) {
        if (
          error?.code === 'SPORTAPI_DAILY_LIMIT' ||
          error?.code === 'SPORTAPI_MONTHLY_LIMIT' ||
          error?.status === 429
        ) {
          throw error;
        }

        console.error(
          'BATBOT : analyse collective impossible pour un lot :',
          error.message
        );
        throw error;
      }
    }

    const uniquePicks = [...new Map(
      qualified.map(pick => [pick.fixtureId, pick])
    ).values()];

    uniquePicks.sort((a, b) =>
      b.market.probability - a.market.probability
    );

    const picks = uniquePicks.slice(0, MAX_DAILY_PICKS);

    const saved = await savePreparedPicks(client, targetDate, picks);
    const finalPicks = saved.picks;

    console.log(
      saved.alreadyPrepared
        ? `BATBOT : préparation du ${targetDate} déjà enregistrée, conservation des ${finalPicks.length} pronostic(s) existant(s).`
        : `BATBOT : ${finalPicks.length} pronostic(s) collectif(s) préparé(s) pour le ${targetDate}.`
    );

    return {
      prepared: saved.prepared,
      alreadyPrepared: saved.alreadyPrepared,
      alreadyPublished: saved.alreadyPublished || false,
      date: targetDate,
      count: finalPicks.length,
      picks: finalPicks
    };
  });
}

module.exports.prepareDailyPicks = prepareDailyPicks;

function evaluateDailyPick(code, homeGoals, awayGoals) {
  if (
    homeGoals === null ||
    homeGoals === undefined ||
    awayGoals === null ||
    awayGoals === undefined ||
    homeGoals === '' ||
    awayGoals === ''
  ) {
    return null;
  }

  const home = Number(homeGoals);
  const away = Number(awayGoals);

  if (
    !Number.isInteger(home) ||
    !Number.isInteger(away) ||
    home < 0 ||
    away < 0
  ) {
    return null;
  }

  const total = home + away;

  if (code === '1') return home > away;
  if (code === 'X') return home === away;
  if (code === '2') return away > home;
  if (code === '1X') return home >= away;
  if (code === 'X2') return away >= home;
  if (code === '12') return home !== away;
  if (code === 'BTTS_YES') return home > 0 && away > 0;
  if (code === 'BTTS_NO') return home === 0 || away === 0;

  const totalMatch = code.match(/^(OVER|UNDER)(05|15|25|35|45|55|65)$/);

  if (totalMatch) {
    const line = Number(totalMatch[2]) / 10;
    return totalMatch[1] === 'OVER' ? total > line : total < line;
  }

  const teamMatch = code.match(/^(HOME|AWAY)_(OVER|UNDER)(05|15|25|35)$/);

  if (teamMatch) {
    const goals = teamMatch[1] === 'HOME' ? home : away;
    const line = Number(teamMatch[3]) / 10;
    return teamMatch[2] === 'OVER' ? goals > line : goals < line;
  }

  return null;
}

async function updateDailyPickResults() {
  return withDailyLock(async client => {
    const today = getAbidjanDate();

    const stateResult = await client.query(`
      SELECT published_for, published_picks
      FROM batbot_free_daily_state
      WHERE state_key = $1
        AND published_for = $2::date
    `, [DAILY_STATE_KEY, today]);

    if (!stateResult.rows.length) {
      return { updated: false, reason: 'Aucune publication active.' };
    }

    const picks = stateResult.rows[0].published_picks || [];
    const pending = picks.filter(pick => pick.status === 'pending');

    if (!pending.length) {
      return { updated: false, reason: 'Tous les matchs sont déjà réglés.' };
    }

    const dates = [...new Set(
      pending.map(pick => String(pick.kickoff || '').slice(0, 10))
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
    )];

    const fixturesById = new Map();

    for (const date of dates) {
      const response = await fetchFixtures(date);

      for (const fixture of response.fixtures || []) {
        fixturesById.set(String(fixture.fixture.id), fixture);
      }
    }

    let settledCount = 0;

    const updatedPicks = picks.map(pick => {
      if (pick.status !== 'pending') return pick;

      const fixture = fixturesById.get(String(pick.fixtureId));
      if (!fixture) return pick;

      const status = fixture.fixture?.status?.short;
      const home = fixture.goals?.home;
      const away = fixture.goals?.away;

      if (status !== 'FT' || home == null || away == null) {
        return pick;
      }

      const correct = evaluateDailyPick(
        pick.market?.code,
        home,
        away
      );

      if (correct === null) return pick;

      settledCount++;

      return {
        ...pick,
        status: correct ? 'validated' : 'not_validated',
        statusLabel: correct ? 'VALIDÉ' : 'NON VALIDÉ',
        score: {
          home: Number(home),
          away: Number(away)
        },
        settledAt: new Date().toISOString()
      };
    });

    if (settledCount > 0) {
      await client.query(`
        UPDATE batbot_free_daily_state
        SET published_picks = $2::jsonb,
            updated_at = NOW()
        WHERE state_key = $1
      `, [DAILY_STATE_KEY, JSON.stringify(updatedPicks)]);
    }

    return {
      updated: settledCount > 0,
      settledCount,
      picks: updatedPicks
    };
  });
}

module.exports.evaluateDailyPick = evaluateDailyPick;
module.exports.updateDailyPickResults = updateDailyPickResults;

async function publishDailyPicks(targetDate) {
  let result = await withDailyLock(async client => {
    const active = await client.query(`
      SELECT published_for, published_picks
      FROM batbot_free_daily_state
      WHERE state_key = $1
        AND published_for = $2::date
    `, [DAILY_STATE_KEY, targetDate]);

    if (active.rows.length) {
      return {
        published: true,
        alreadyPublished: true,
        date: active.rows[0].published_for,
        picks: active.rows[0].published_picks
      };
    }

    return publishPreparedPicks(client, targetDate);
  });

  if (result.skipped || result.alreadyPublished || result.empty) return result;

  if (!result.published) {
    console.log(
      `BATBOT : préparation manquante pour ${targetDate}, lancement du rattrapage.`
    );

    const preparation = await prepareDailyPicks(targetDate);

    if (preparation.skipped) return preparation;

    result = await withDailyLock(async client => {
      const active = await client.query(`
        SELECT published_for, published_picks
        FROM batbot_free_daily_state
        WHERE state_key = $1
          AND published_for = $2::date
      `, [DAILY_STATE_KEY, targetDate]);

      if (active.rows.length) {
        return {
          published: true,
          alreadyPublished: true,
          date: active.rows[0].published_for,
          picks: active.rows[0].published_picks
        };
      }

      return publishPreparedPicks(client, targetDate);
    });
  }

  if (result.published && !result.alreadyPublished) {
    console.log(
      `BATBOT : publication collective du ${targetDate} effectuée (${result.picks.length} pronostic(s)).`
    );
  }

  return result;
}

function millisecondsUntilAbidjanTime(hour, minute) {
  // Africa/Abidjan utilise UTC+0.
  const now = new Date();
  const target = new Date(now);

  target.setUTCHours(hour, minute, 0, 0);

  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now.getTime();
}

function startFreeDailyPredictionScheduler() {
  if (!databasePool) {
    throw new Error('Initialisez le service collectif avant son programmateur.');
  }

  let stopped = false;
  let preparationTimer = null;
  let publicationTimer = null;
  let resultsTimer = null;

  const RETRY_INTERVAL_MS = 5 * 60 * 1000;

  function schedulePreparation(delay = millisecondsUntilAbidjanTime(23, 30), targetDate = null) {
    if (stopped) return;

    preparationTimer = setTimeout(async () => {
      const today = getAbidjanDate();
      const date = targetDate && targetDate >= today
        ? targetDate
        : getNextDate(today);

      try {
        const result = await prepareDailyPicks(date);

        if (result.skipped || result.prepared !== true) {
          console.warn('BATBOT : préparation reportée, nouvelle tentative dans 5 minutes.');
          schedulePreparation(RETRY_INTERVAL_MS, date);
          return;
        }

        schedulePreparation();
      } catch (error) {
        console.error(
          'BATBOT : préparation quotidienne impossible :',
          error.message
        );
        schedulePreparation(RETRY_INTERVAL_MS, date);
      }
    }, delay);

    preparationTimer.unref();
  }

  function schedulePublication(delay = millisecondsUntilAbidjanTime(0, 0), targetDate = null) {
    if (stopped) return;

    publicationTimer = setTimeout(async () => {
      const date = targetDate || getAbidjanDate();

      try {
        const result = await publishDailyPicks(date);

        if (result.empty) {
        console.log(
          `BATBOT : aucun pronostic admissible pour ${date}. Prochaine publication au prochain cycle quotidien.`
        );
        schedulePublication();
        return;
      }

      if (result.skipped || result.published !== true) {
          console.warn('BATBOT : publication reportée, nouvelle tentative dans 5 minutes.');
          schedulePublication(RETRY_INTERVAL_MS);
          return;
        }

        schedulePublication();
      } catch (error) {
        console.error(
          'BATBOT : publication quotidienne impossible :',
          error.message
        );
        schedulePublication(RETRY_INTERVAL_MS);
      }
    }, delay);

    publicationTimer.unref();
  }

  function scheduleResultsUpdate() {
    if (stopped) return;

    resultsTimer = setTimeout(async () => {
      try {
        const result = await updateDailyPickResults();

        if (result.settledCount > 0) {
          console.log(
            `BATBOT : ${result.settledCount} résultat(s) collectif(s) actualisé(s).`
          );
        }
      } catch (error) {
        console.error(
          'BATBOT : actualisation automatique des scores impossible :',
          error.message
        );
      } finally {
        scheduleResultsUpdate();
      }
    }, 5 * 60 * 1000);

    resultsTimer.unref();
  }

  schedulePreparation();
  scheduleResultsUpdate();

  // Récupération immédiate de la publication du jour au démarrage.
  // En cas d'échec ou de verrou occupé, nouvelle tentative après 5 minutes.
  schedulePublication(0, getAbidjanDate());

  console.log(
    'BATBOT : programmateur collectif actif (préparation 23 h 30, publication minuit avec reprises toutes les 5 minutes, scores toutes les 5 minutes).'
  );

  return function stopScheduler() {
    stopped = true;
    clearTimeout(preparationTimer);
    clearTimeout(publicationTimer);
    clearTimeout(resultsTimer);
  };
}

module.exports.publishDailyPicks = publishDailyPicks;
module.exports.startFreeDailyPredictionScheduler =
  startFreeDailyPredictionScheduler;

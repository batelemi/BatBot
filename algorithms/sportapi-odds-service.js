'use strict';

const { calculateOdds, MIN_MATCHES } = require('./odds-engine');

const API_BASE = 'https://sportapi.ai/api';
const { reserveSportApiCall } = require('./sportapi-quota');
const REQUEST_TIMEOUT_MS = 15000;
const HISTORY_LIMIT = 12;
const { createTeamHistoryCache } = require('./sportapi-team-history-cache');

let teamHistoryCache = null;

async function initializeSportApiTeamHistoryCache(pool) {
  teamHistoryCache = createTeamHistoryCache({
    pool,
    fetchHistory: fetchTeamHistory
  });
  await teamHistoryCache.initialize();
}
const FINISHED_STATUSES = new Set([
  'FT', 'AET', 'PEN', 'PENS', 'FINISHED', 'FULL_TIME', 'COMPLETED',
  'AFTER_EXTRA_TIME', 'AFTER_PENALTIES', 'ENDED'
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|club|football club|cd)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getStatus(match) {
  return String(
    match?.status?.short || match?.status?.long || match?.status ||
    match?.fixture?.status?.short || match?.fixture?.status?.long || ''
  ).trim().toUpperCase().replace(/[\s.-]+/g, '_');
}

function readScore(match, side) {
  const values = side === 'home'
    ? [match?.home_score, match?.homeScore, match?.goals?.home, match?.score?.home, match?.score?.fulltime?.home]
    : [match?.away_score, match?.awayScore, match?.goals?.away, match?.score?.away, match?.score?.fulltime?.away];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const score = Number(value);
    if (Number.isFinite(score) && score >= 0) return score;
  }
  return null;
}

function getTeamId(match, side) {
  const values = side === 'home'
    ? [match?.home_id, match?.home_team_id, match?.homeTeam?.id,
       match?.home_team_data?.id, match?.home?.id,
       match?.home_team?.id, match?.teams?.home?.id]
    : [match?.away_id, match?.away_team_id, match?.awayTeam?.id,
       match?.away_team_data?.id, match?.away?.id,
       match?.away_team?.id, match?.teams?.away?.id];
  const value = values.find(v =>
    v !== null && v !== undefined && String(v).trim() !== ''
  );
  return value === undefined ? null : String(value);
}

function getTeamName(match, side) {
  const values = side === 'home'
    ? [match?.home_team, match?.homeTeam?.name,
       match?.home_team_data?.name, match?.home?.name,
       match?.home_team?.name, match?.teams?.home?.name, match?.home]
    : [match?.away_team, match?.awayTeam?.name,
       match?.away_team_data?.name, match?.away?.name,
       match?.away_team?.name, match?.teams?.away?.name, match?.away];
  const value = values.find(v => typeof v === 'string' && v.trim());
  return String(value || '')
    .replace(/^\s*(?:[\w-]+\.(?:png|jpe?g|webp|svg)\s*)+/i, '')
    .trim();
}

function isFinishedMatch(match) {
  return FINISHED_STATUSES.has(getStatus(match));
}

function collectTeamStats(matches, teamId, teamName) {
  const targetId = String(teamId);
  const targetName = normalizeText(teamName);
  const valid = [];

  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || !isFinishedMatch(match)) continue;
    const homeScore = readScore(match, 'home');
    const awayScore = readScore(match, 'away');
    if (homeScore === null || awayScore === null) continue;

    const homeId = getTeamId(match, 'home');
    const awayId = getTeamId(match, 'away');
    let side = '';
    if (homeId !== null || awayId !== null) {
      if (homeId === targetId) side = 'home';
      else if (awayId === targetId) side = 'away';
      else continue;
    } else {
      // Le nom n'est utilisé qu'en l'absence complète d'identifiants dans l'historique.
      const homeName = normalizeText(getTeamName(match, 'home'));
      const awayName = normalizeText(getTeamName(match, 'away'));
      if (targetName && homeName === targetName) side = 'home';
      else if (targetName && awayName === targetName) side = 'away';
      else continue;
    }

    const date = Date.parse(match?.kickoff_utc || match?.datetime || match?.date || match?.time || match?.fixture?.date || 0);
    valid.push({ side, homeScore, awayScore, date: Number.isFinite(date) ? date : 0 });
  }

  valid.sort((a, b) => b.date - a.date);
  const recent = valid.slice(0, HISTORY_LIMIT);
  const stats = {
    matches: recent.length,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    homeMatches: 0,
    homeGoalsFor: 0,
    homeGoalsAgainst: 0,
    awayMatches: 0,
    awayGoalsFor: 0,
    awayGoalsAgainst: 0
  };

  for (const item of recent) {
    const own = item.side === 'home' ? item.homeScore : item.awayScore;
    const against = item.side === 'home' ? item.awayScore : item.homeScore;
    stats.goalsFor += own;
    stats.goalsAgainst += against;
    if (own > against) stats.wins += 1;
    else if (own === against) stats.draws += 1;
    else stats.losses += 1;

    if (item.side === 'home') {
      stats.homeMatches += 1;
      stats.homeGoalsFor += own;
      stats.homeGoalsAgainst += against;
    } else {
      stats.awayMatches += 1;
      stats.awayGoalsFor += own;
      stats.awayGoalsAgainst += against;
    }
  }

  return stats;
}

async function addAnalysisEligibilityToFixtures(fixtures) {
  if (!Array.isArray(fixtures)) return [];

  return Promise.all(fixtures.map(async fixture => {
    const homeId = fixture?.teams?.home?.id;
    const awayId = fixture?.teams?.away?.id;
    const homeName = String(fixture?.teams?.home?.name || '').trim();
    const awayName = String(fixture?.teams?.away?.name || '').trim();

    if (!teamHistoryCache || !homeId || !awayId || !homeName || !awayName) {
      return { ...fixture, analysis_available: false };
    }

    try {
      const [homeHistory, awayHistory] = await Promise.all([
        teamHistoryCache.getFreshCachedTeamHistory(homeId),
        teamHistoryCache.getFreshCachedTeamHistory(awayId)
      ]);

      if (!homeHistory || !awayHistory) {
        return { ...fixture, analysis_available: false };
      }

      const homeStats = collectTeamStats(homeHistory, homeId, homeName);
      const awayStats = collectTeamStats(awayHistory, awayId, awayName);

      return {
        ...fixture,
        analysis_available:
          homeStats.matches >= MIN_MATCHES &&
          awayStats.matches >= MIN_MATCHES
      };
    } catch (error) {
      console.warn(
        'BATBOT : vérification des historiques en cache impossible :',
        error.message
      );
      return { ...fixture, analysis_available: false };
    }
  }));
}

function extractHistoryMatches(payload) {
  const candidates = [
    payload?.matches,
    payload?.results,
    payload?.data?.matches,
    payload?.data?.results,
    payload?.data
  ];
  return candidates.find(Array.isArray) || null;
}

async function fetchTeamHistory(teamId, apiKey) {
  await reserveSportApiCall('team-history');
  const response = await fetch(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`SportAPI.ai équipe ${teamId}: HTTP ${response.status}.`);
  const matches = extractHistoryMatches(payload);
  if (!matches) throw new Error(`Réponse historique SportAPI.ai inattendue pour l'équipe ${teamId}.`);
  return matches;
}

const MIN_RECOMMENDATION_PROBABILITY = 60;

function makeModel(odds, homeStats, awayStats, homeName, awayName) {
  if (!odds?.sufficientData) {
    return {
      ready: false,
      sufficientData: false,
      recommendation: 'Analyse insuffisante',
      recommendationCode: null,
      reason: odds?.reason || `Au moins ${MIN_MATCHES} matchs terminés avec score vérifiable sont nécessaires pour chaque équipe.`,
      probabilities: [],
      options: [],
      data_quality: 'limitée'
    };
  }

  const probabilities = [
    { label: '1', value: odds.oneXTwo?.home?.probability },
    { label: 'X', value: odds.oneXTwo?.draw?.probability },
    { label: '2', value: odds.oneXTwo?.away?.probability }
  ].map(item => ({ ...item, value: Number(item.value) }));

  const definitions = [
    { code: '1', name: `Victoire ${homeName}`, probability: odds.oneXTwo?.home?.probability, group: 'result' },
    { code: 'X', name: 'Match nul', probability: odds.oneXTwo?.draw?.probability, group: 'result' },
    { code: '2', name: `Victoire ${awayName}`, probability: odds.oneXTwo?.away?.probability, group: 'result' },

    { code: '1X', name: `${homeName} ou match nul`, probability: odds.markets?.['1X']?.probability, group: 'double' },
    { code: 'X2', name: `${awayName} ou match nul`, probability: odds.markets?.['X2']?.probability, group: 'double' },
    { code: '12', name: 'Une des deux équipes gagne', probability: odds.markets?.['12']?.probability, group: 'double' },

    ...[0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5].flatMap(line => {
      const suffix = String(line).replace('.', '');
      return [
        { code: `OVER${suffix}`, name: `Over ${line}`, probability: odds.markets?.totalGoals?.[`over${suffix}`]?.probability, group: 'goals' },
        { code: `UNDER${suffix}`, name: `Under ${line}`, probability: odds.markets?.totalGoals?.[`under${suffix}`]?.probability, group: 'goals' }
      ];
    }),

    ...[0.5, 1.5, 2.5, 3.5].flatMap(line => {
      const suffix = String(line).replace('.', '');
      return [
        { code: `HOME_OVER${suffix}`, name: `${homeName} plus de ${line} but`, probability: odds.markets?.homeGoals?.[`over${suffix}`]?.probability, group: 'home-goals' },
        { code: `HOME_UNDER${suffix}`, name: `${homeName} moins de ${line} but`, probability: odds.markets?.homeGoals?.[`under${suffix}`]?.probability, group: 'home-goals' },
        { code: `AWAY_OVER${suffix}`, name: `${awayName} plus de ${line} but`, probability: odds.markets?.awayGoals?.[`over${suffix}`]?.probability, group: 'away-goals' },
        { code: `AWAY_UNDER${suffix}`, name: `${awayName} moins de ${line} but`, probability: odds.markets?.awayGoals?.[`under${suffix}`]?.probability, group: 'away-goals' }
      ];
    }),

    { code: 'BTTS_YES', name: 'Les deux équipes marquent : Oui', probability: odds.markets?.bttsYes?.probability, group: 'btts' },
    { code: 'BTTS_NO', name: 'Les deux équipes marquent : Non', probability: odds.markets?.bttsNo?.probability, group: 'btts' },

    ...Object.entries(odds.markets?.goalRanges || {}).map(([range, market]) => ({
      code: `GOAL_RANGE_${range.replace(/[^0-9]/g, '_')}`,
      name: `Tranche de buts ${range}`,
      probability: market?.probability,
      group: 'ranges'
    })),

    ...(odds.markets?.topScores || []).map(item => ({
      code: `SCORE_${String(item.score).replace('-', '_')}`,
      name: `Score exact ${item.score}`,
      probability: item.probability,
      group: 'exact-score'
    }))
  ];

  const options = definitions
    .filter(item =>
      item.probability !== null &&
      item.probability !== undefined &&
      Number.isFinite(Number(item.probability)) &&
      Number(item.probability) >= 0 &&
      Number(item.probability) <= 100
    )
    .map(item => {
      const probability = Number(item.probability);
      return {
        code: item.code,
        name: item.name,
        probability,
        theoreticalOdds: probability > 0
          ? Number((100 / probability).toFixed(2))
          : null,
        risk: probability >= 75 ? 'faible' :
          probability >= 60 ? 'modéré' : 'élevé',
        reason: 'Probabilité calculée par le moteur Poisson v3 à partir de l’historique SportAPI.ai vérifié.',
        group: item.group
      };
    });

  const eligible = options.filter(item =>
    item.probability >= MIN_RECOMMENDATION_PROBABILITY &&
    item.probability <= 85 &&
    ['result', 'double', 'goals', 'home-goals', 'away-goals', 'btts'].includes(item.group)
  );

  const best = eligible.reduce((current, item) => {
    if (!current) return item;
    const currentDistance = Math.abs(current.probability - 70);
    const itemDistance = Math.abs(item.probability - 70);
    return itemDistance < currentDistance ? item : current;
  }, null);

  return {
    ready: true,
    sufficientData: true,
    model: odds.model,
    recommendation: best?.name || 'Aucun marché suffisamment fiable',
    recommendationCode: best?.code || null,
    reason: best
      ? `Le marché ${best.name} a été retenu parmi les marchés pertinents dont la probabilité se situe entre ${MIN_RECOMMENDATION_PROBABILITY} % et 85 %. Analyse Poisson v3 fondée sur l’historique terminé de SportAPI.ai pour ${homeName} à domicile et ${awayName} à l’extérieur.`
      : `Aucun marché pertinent n’atteint les critères de sélection. Aucun pronostic principal n’est recommandé.`,
    probabilities,
    options,
    expected_goals: odds.expectedGoals,
    most_likely_score: odds.mostLikelyScore,
    markets: odds.markets,
    context: odds.context,
    data_quality: 'bonne'
  };
}

async function analyzeSportApiMatches(fixtures, options = {}) {
  if (!Array.isArray(fixtures) || !fixtures.length) throw new Error('Aucun match SportAPI.ai à analyser.');
  const apiKey = options.apiKey || process.env.SPORTAPI_KEY;
  if (!apiKey) throw new Error('SPORTAPI_KEY absente de l’environnement.');

  const selected = fixtures.slice(0, 2);
  const results = await Promise.all(selected.map(async fixture => {
    const homeId = fixture?.teams?.home?.id;
    const awayId = fixture?.teams?.away?.id;
    const homeName = String(fixture?.teams?.home?.name || '').trim();
    const awayName = String(fixture?.teams?.away?.name || '').trim();
    if (!homeId || !awayId || !homeName || !awayName) {
      return {
        match: `${homeName || 'Équipe domicile'} vs ${awayName || 'Équipe extérieur'}`,
        fixture,
        ready: false,
        sufficientData: false,
        recommendation: 'Match non vérifiable',
        reason: 'Les identifiants réels des deux équipes sont nécessaires pour récupérer leur historique SportAPI.ai.',
        data_quality: 'non vérifiée',
        model: { ready: false, sufficientData: false, probabilities: [], options: [], recommendation: 'Match non vérifiable', reason: 'Identifiants SportAPI.ai manquants.', data_quality: 'non vérifiée' }
      };
    }

    const getHistory = teamHistoryCache
      ? teamHistoryCache.getTeamHistory.bind(teamHistoryCache)
      : fetchTeamHistory;

    const historyResults = await Promise.allSettled([
      getHistory(homeId, apiKey),
      getHistory(awayId, apiKey)
    ]);

    const quotaError = historyResults
      .filter(result => result.status === 'rejected')
      .map(result => result.reason)
      .find(error => error?.code === 'SPORTAPI_DAILY_LIMIT' || error?.status === 429);

    if (quotaError) throw quotaError;

    const homeHistory = historyResults[0].status === 'fulfilled'
      && Array.isArray(historyResults[0].value)
      ? historyResults[0].value : [];

    const awayHistory = historyResults[1].status === 'fulfilled'
      && Array.isArray(historyResults[1].value)
      ? historyResults[1].value : [];
    const homeStats = collectTeamStats(homeHistory, homeId, homeName);
    const awayStats = collectTeamStats(awayHistory, awayId, awayName);
    const odds = calculateOdds({ home: homeStats, away: awayStats });
    const model = makeModel(odds, homeStats, awayStats, homeName, awayName);
    if (!odds?.sufficientData) {
      model.reason = odds?.reason || model.reason;
      model.data_quality = 'limitée';
    }

    return {
      match: `${homeName} vs ${awayName}`,
      fixture,
      ready: model.ready === true,
      sufficientData: model.sufficientData === true,
      recommendation: model.recommendation,
      recommendationCode: model.recommendationCode || null,
      reason: model.reason,
      data_quality: model.data_quality,
      homeTeam: {
        id: String(homeId),
        name: homeName,
        logo: fixture?.teams?.home?.logo || fixture?.teams?.home?.flag || null,
        flag: fixture?.teams?.home?.flag || fixture?.teams?.home?.logo || null,
        slug: fixture?.teams?.home?.slug || null
      },
      awayTeam: {
        id: String(awayId),
        name: awayName,
        logo: fixture?.teams?.away?.logo || fixture?.teams?.away?.flag || null,
        flag: fixture?.teams?.away?.flag || fixture?.teams?.away?.logo || null,
        slug: fixture?.teams?.away?.slug || null
      },
      stats: { home: homeStats, away: awayStats },
      model,
      odds
    };
  }));

  return {
    source: 'SportAPI.ai',
    generatedAt: new Date().toISOString(),
    matches: results,
    models: results.map(item => item.model)
  };
}

module.exports = {
  analyzeSportApiMatches,
  initializeSportApiTeamHistoryCache,
  addAnalysisEligibilityToFixtures,
  collectTeamStats,
  isFinishedMatch,
  extractHistoryMatches,
  readScore,
  makeModel,
};

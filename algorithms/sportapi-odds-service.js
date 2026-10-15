'use strict';

const { calculateOdds, MIN_MATCHES } = require('./odds-engine');

const API_BASE = 'https://sportapi.ai/api';
const REQUEST_TIMEOUT_MS = 15000;
const HISTORY_LIMIT = 12;
const FINISHED_STATUSES = new Set([
  'FT', 'AET', 'PEN', 'FINISHED', 'FULL_TIME', 'COMPLETED',
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
  const direct = side === 'home'
    ? [match?.home_id, match?.home_team_id, match?.home?.id, match?.home_team?.id, match?.teams?.home?.id]
    : [match?.away_id, match?.away_team_id, match?.away?.id, match?.away_team?.id, match?.teams?.away?.id];
  const value = direct.find(item => item !== null && item !== undefined && String(item).trim() !== '');
  return value === undefined ? null : String(value);
}

function getTeamName(match, side) {
  const value = side === 'home'
    ? (match?.home_team || match?.home?.name || match?.home_team_data?.name || match?.teams?.home?.name || match?.home)
    : (match?.away_team || match?.away?.name || match?.away_team_data?.name || match?.teams?.away?.name || match?.away);
  return String(value || '').trim();
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

async function fetchTeamHistory(teamId, apiKey) {
  const response = await fetch(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`SportAPI.ai équipe ${teamId}: HTTP ${response.status}.`);
  const matches = Array.isArray(payload?.matches)
    ? payload.matches
    : Array.isArray(payload?.data?.matches)
      ? payload.data.matches
      : null;
  if (!matches) throw new Error(`Réponse historique SportAPI.ai inattendue pour l'équipe ${teamId}.`);
  return matches;
}

function makeModel(odds, homeStats, awayStats, homeName, awayName) {
  if (!odds?.sufficientData) {
    return {
      ready: false,
      sufficientData: false,
      recommendation: 'Analyse insuffisante',
      reason: odds?.reason || `Au moins ${MIN_MATCHES} matchs terminés avec score vérifiable sont nécessaires pour chaque équipe.`,
      probabilities: [],
      options: [],
      data_quality: 'limitée'
    };
  }

  const probabilities = [
    { label: '1', value: odds.oneXTwo.home.probability },
    { label: 'X', value: odds.oneXTwo.draw.probability },
    { label: '2', value: odds.oneXTwo.away.probability }
  ];
  const options = [
    { name: '1', probability: odds.oneXTwo.home.probability },
    { name: 'X', probability: odds.oneXTwo.draw.probability },
    { name: '2', probability: odds.oneXTwo.away.probability },
    { name: 'Over 1.5', probability: odds.markets.over15.probability },
    { name: 'Over 2.5', probability: odds.markets.over25.probability },
    { name: 'Over 3.5', probability: odds.markets.over35.probability },
    { name: 'Under 2.5', probability: odds.markets.under25.probability },
    { name: 'Under 3.5', probability: odds.markets.under35.probability },
    { name: 'BTTS Oui', probability: odds.markets.bttsYes.probability },
    { name: 'BTTS Non', probability: odds.markets.bttsNo.probability }
  ].map(item => ({
    ...item,
    risk: item.probability >= 70 ? 'faible' : item.probability >= 55 ? 'modéré' : 'élevé',
    reason: 'Probabilité calculée par le moteur Poisson v3 à partir de l’historique SportAPI.ai vérifié.'
  }));
  const best = probabilities.reduce((current, item) => !current || item.value > current.value ? item : current, null);

  return {
    ready: true,
    sufficientData: true,
    model: odds.model,
    recommendation: best?.label || 'Analyse insuffisante',
    reason: `Le modèle Poisson v3 compare ${homeName} à domicile et ${awayName} à l’extérieur à partir de l’historique terminé fourni par SportAPI.ai.`,
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
        recommendation: 'Match non vérifiable',
        reason: 'Les identifiants réels des deux équipes sont nécessaires pour récupérer leur historique SportAPI.ai.',
        data_quality: 'non vérifiée',
        model: { ready: false, probabilities: [], options: [], recommendation: 'Match non vérifiable', reason: 'Identifiants SportAPI.ai manquants.', data_quality: 'non vérifiée' }
      };
    }

    const [homeHistory, awayHistory] = await Promise.all([
      fetchTeamHistory(homeId, apiKey),
      fetchTeamHistory(awayId, apiKey)
    ]);
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
      ready: Boolean(odds?.sufficientData),
      recommendation: model.recommendation,
      reason: model.reason,
      data_quality: model.data_quality,
      homeTeam: { id: String(homeId), name: homeName },
      awayTeam: { id: String(awayId), name: awayName },
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
  collectTeamStats,
  isFinishedMatch,
  readScore
};

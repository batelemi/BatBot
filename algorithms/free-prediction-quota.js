"use strict";

const crypto = require("crypto");

async function initializeFreePredictionQuota(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS free_prediction_quota (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'consumed')),
      reservation_token UUID,
      reserved_until TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (status = 'reserved' AND reservation_token IS NOT NULL
          AND reserved_until IS NOT NULL AND consumed_at IS NULL)
        OR
        (status = 'consumed' AND reservation_token IS NULL
          AND reserved_until IS NULL AND consumed_at IS NOT NULL)
      )
    )
  `);
}

async function reserveFreePrediction(pool, userId) {
  const token = crypto.randomUUID();

  const result = await pool.query(`
    INSERT INTO free_prediction_quota
      (user_id, status, reservation_token, reserved_until)
    VALUES ($1, 'reserved', $2, NOW() + INTERVAL '30 minutes')
    ON CONFLICT (user_id) DO UPDATE
      SET status = 'reserved',
          reservation_token = EXCLUDED.reservation_token,
          reserved_until = EXCLUDED.reserved_until
      WHERE free_prediction_quota.status = 'reserved'
        AND free_prediction_quota.reserved_until <= NOW()
    RETURNING user_id
  `, [userId, token]);

  if (result.rowCount === 1) {
    return { ok: true, token };
  }

  const existing = await pool.query(`
    SELECT status, reserved_until
    FROM free_prediction_quota
    WHERE user_id = $1
  `, [userId]);

  const row = existing.rows[0];

  return {
    ok: false,
    reason: row?.status === 'consumed'
      ? 'already_used'
      : 'already_reserved'
  };
}

async function consumeFreePrediction(pool, userId, token) {
  const result = await pool.query(`
    UPDATE free_prediction_quota
    SET status = 'consumed',
        reservation_token = NULL,
        reserved_until = NULL,
        consumed_at = NOW()
    WHERE user_id = $1
      AND status = 'reserved'
      AND reservation_token = $2
  `, [userId, token]);

  return result.rowCount === 1;
}

async function releaseFreePrediction(pool, userId, token) {
  const result = await pool.query(`
    DELETE FROM free_prediction_quota
    WHERE user_id = $1
      AND status = 'reserved'
      AND reservation_token = $2
  `, [userId, token]);

  return result.rowCount === 1;
}

async function getFreePredictionStatus(pool, userId) {
  const result = await pool.query(`
    SELECT
      status,
      consumed_at,
      (status = 'reserved' AND reserved_until > NOW()) AS reserved
    FROM free_prediction_quota
    WHERE user_id = $1
  `, [userId]);

  const row = result.rows[0];

  return {
    used: row?.status === 'consumed',
    reserved: row?.reserved === true,
    available: !row || (
      row.status === 'reserved' && row.reserved !== true
    ),
    consumed_at: row?.consumed_at || null
  };
}

module.exports = {
  initializeFreePredictionQuota,
  reserveFreePrediction,
  consumeFreePrediction,
  releaseFreePrediction,
  getFreePredictionStatus
};

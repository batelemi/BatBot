"use strict";

const crypto = require("crypto");
const net = require("net");

const EVENT_TYPES = new Set([
  "registration",
  "free_prediction"
]);

function getIpSecret() {
  const secret = String(process.env.IP_HASH_SECRET || "").trim();

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("IP_HASH_SECRET est obligatoire en production.");
    }
    return null;
  }

  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("IP_HASH_SECRET doit contenir au moins 32 octets.");
  }

  return secret;
}

function normalizeClientIp(req) {
  let ip = String(
    req?.ip ||
    req?.socket?.remoteAddress ||
    ""
  ).trim();

  if (!ip) return null;

  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }

  if (ip.includes("%")) {
    ip = ip.split("%")[0];
  }

  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function hashClientIp(req) {
  const secret = getIpSecret();
  if (!secret) return null;

  const ip = normalizeClientIp(req);
  if (!ip) return null;

  return crypto
    .createHmac("sha256", secret)
    .update(ip)
    .digest("hex");
}

async function initializeFreePredictionIp(pool) {
  getIpSecret();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS free_prediction_ip_events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL
        CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
      event_type TEXT NOT NULL
        CHECK (event_type IN ('registration', 'free_prediction')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, event_type)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_free_prediction_ip_events_lookup
    ON free_prediction_ip_events(ip_hash, event_type, created_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_free_prediction_ip_events_user
    ON free_prediction_ip_events(user_id)
  `);

  await pool.query(`
    DELETE FROM free_prediction_ip_events
    WHERE created_at < NOW() - INTERVAL '90 days'
  `);

  console.log("BATBOT IP: protection des pronostics initialisée.");
}

async function recordFreePredictionIpEvent(
  db,
  userId,
  ipHash,
  eventType
) {
  if (!ipHash) return false;

  if (!EVENT_TYPES.has(eventType)) {
    throw new Error("Type d'événement IP invalide.");
  }

  if (!/^[0-9a-f]{64}$/.test(ipHash)) {
    throw new Error("Empreinte IP invalide.");
  }

  const result = await db.query(`
    INSERT INTO free_prediction_ip_events
      (user_id, ip_hash, event_type)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, event_type) DO NOTHING
    RETURNING id
  `, [userId, ipHash, eventType]);

  return result.rowCount === 1;
}

async function getFreePredictionIpRisk(db, ipHash, userId) {
  if (!ipHash) {
    return {
      available: false,
      registrationAccounts: 0,
      previousFreeAccounts: 0
    };
  }

  const result = await db.query(`
    SELECT
      COUNT(DISTINCT user_id) FILTER (
        WHERE event_type = 'registration'
      )::INTEGER AS registration_accounts,

      COUNT(DISTINCT user_id) FILTER (
        WHERE event_type = 'free_prediction'
          AND user_id <> $2
      )::INTEGER AS previous_free_accounts

    FROM free_prediction_ip_events
    WHERE ip_hash = $1
      AND created_at >= NOW() - INTERVAL '90 days'
  `, [ipHash, userId]);

  const row = result.rows[0] || {};

  return {
    available: true,
    registrationAccounts: Number(row.registration_accounts || 0),
    previousFreeAccounts: Number(row.previous_free_accounts || 0)
  };
}

module.exports = {
  initializeFreePredictionIp,
  hashClientIp,
  recordFreePredictionIpEvent,
  getFreePredictionIpRisk
};

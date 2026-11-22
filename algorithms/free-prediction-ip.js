"use strict";

const crypto = require("crypto");
const net = require("net");

const EVENT_TYPES = new Set(["registration", "free_prediction"]);
const IP_RESERVATION_MINUTES = 30;
const IP_BLOCK_DAYS = 90;

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
    req?.ip || req?.socket?.remoteAddress || ""
  ).trim();

  if (!ip) return null;

  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  if (ip.includes("%")) ip = ip.split("%")[0];

  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function hashClientIp(req) {
  const secret = getIpSecret();
  if (!secret) return null;

  const ip = normalizeClientIp(req);
  if (!ip) return null;

  return crypto.createHmac("sha256", secret)
    .update(ip)
    .digest("hex");
}

function validateIpHash(ipHash) {
  if (!/^[0-9a-f]{64}$/.test(String(ipHash || ""))) {
    throw new Error("Empreinte IP invalide.");
  }
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
    CREATE TABLE IF NOT EXISTS free_prediction_ip_reservations (
      ip_hash TEXT PRIMARY KEY
        CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token UUID NOT NULL UNIQUE,
      status TEXT NOT NULL
        CHECK (status IN ('reserved', 'consumed')),
      reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_free_prediction_ip_reservations_user
    ON free_prediction_ip_reservations(user_id)
  `);

  // Migration : reprendre les pronostics gratuits déjà enregistrés.
  // La dernière prédiction gratuite de chaque IP détermine la fin du blocage.
  await pool.query(`
    INSERT INTO free_prediction_ip_reservations
      (ip_hash, user_id, token, status, reserved_at, expires_at, consumed_at)
    SELECT
      ip_hash,
      user_id,
      gen_random_uuid(),
      'consumed',
      created_at,
      created_at + INTERVAL '90 days',
      created_at
    FROM (
      SELECT DISTINCT ON (ip_hash)
        ip_hash, user_id, created_at
      FROM free_prediction_ip_events
      WHERE event_type = 'free_prediction'
        AND created_at >= NOW() - INTERVAL '90 days'
      ORDER BY ip_hash, created_at DESC, id DESC
    ) AS historical
    ON CONFLICT (ip_hash) DO NOTHING
  `);

  await pool.query(`
    DELETE FROM free_prediction_ip_events
    WHERE created_at < NOW() - INTERVAL '90 days'
  `);

  await pool.query(`
    DELETE FROM free_prediction_ip_reservations
    WHERE (status = 'reserved' AND expires_at <= NOW())
       OR (status = 'consumed' AND expires_at <= NOW())
  `);

  console.log("BATBOT IP: protection des pronostics initialisée.");
}

async function recordFreePredictionIpEvent(db, userId, ipHash, eventType) {
  if (!ipHash) return false;

  if (!EVENT_TYPES.has(eventType)) {
    throw new Error("Type d'événement IP invalide.");
  }

  validateIpHash(ipHash);

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

  validateIpHash(ipHash);

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

async function reserveFreePredictionIp(db, userId, ipHash) {
  if (!ipHash) {
    return { ok: false, reason: "ip_unavailable" };
  }

  validateIpHash(ipHash);

  const token = crypto.randomUUID();

  const result = await db.query(`
    INSERT INTO free_prediction_ip_reservations
      (ip_hash, user_id, token, status, expires_at)
    VALUES (
      $1, $2, $3, 'reserved',
      NOW() + ($4 * INTERVAL '1 minute')
    )
    ON CONFLICT (ip_hash) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        token = EXCLUDED.token,
        status = 'reserved',
        reserved_at = NOW(),
        expires_at = EXCLUDED.expires_at,
        consumed_at = NULL
    WHERE free_prediction_ip_reservations.expires_at <= NOW()
    RETURNING token
  `, [ipHash, userId, token, IP_RESERVATION_MINUTES]);

  if (result.rowCount === 1) {
    return { ok: true, token };
  }

  const existing = await db.query(`
    SELECT user_id, status
    FROM free_prediction_ip_reservations
    WHERE ip_hash = $1
  `, [ipHash]);

  const row = existing.rows[0];

  if (row?.status === "consumed") {
    return { ok: false, reason: "already_used" };
  }

  if (row?.status === "reserved" &&
      String(row.user_id) === String(userId)) {
    return { ok: false, reason: "in_progress" };
  }

  return { ok: false, reason: "ip_used_or_reserved" };
}

// Valide ensemble le quota individuel et le verrou IP.
// Si l'une des deux opérations échoue, les deux sont annulées.
async function consumeFreePredictionWithIp(
  pool, userId, quotaToken, ipHash, ipToken
) {
  if (!ipHash || !ipToken || !quotaToken) {
    return { ok: false, reason: "reservation_missing" };
  }

  validateIpHash(ipHash);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const quota = await client.query(`
      UPDATE free_prediction_quota
      SET status = 'consumed',
          reservation_token = NULL,
          reserved_until = NULL,
          consumed_at = NOW()
      WHERE user_id = $1
        AND status = 'reserved'
        AND reservation_token = $2
        AND reserved_until > NOW()
      RETURNING user_id
    `, [userId, quotaToken]);

    if (quota.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "quota_expired" };
    }

    const ip = await client.query(`
      UPDATE free_prediction_ip_reservations
      SET status = 'consumed',
          consumed_at = NOW(),
          expires_at = NOW() + ($4 * INTERVAL '1 day')
      WHERE ip_hash = $1
        AND user_id = $2
        AND token = $3
        AND status = 'reserved'
        AND expires_at > NOW()
      RETURNING ip_hash
    `, [ipHash, userId, ipToken, IP_BLOCK_DAYS]);

    if (ip.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "ip_reservation_expired" };
    }

    await client.query(`
      INSERT INTO free_prediction_ip_events
        (user_id, ip_hash, event_type)
      VALUES ($1, $2, 'free_prediction')
      ON CONFLICT (user_id, event_type) DO NOTHING
    `, [userId, ipHash]);

    await client.query("COMMIT");

    return { ok: true };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

async function releaseFreePredictionIp(db, userId, ipHash, token) {
  if (!ipHash || !token) return false;

  validateIpHash(ipHash);

  const result = await db.query(`
    DELETE FROM free_prediction_ip_reservations
    WHERE ip_hash = $1
      AND user_id = $2
      AND token = $3
      AND status = 'reserved'
    RETURNING ip_hash
  `, [ipHash, userId, token]);

  return result.rowCount === 1;
}

module.exports = {
  initializeFreePredictionIp,
  hashClientIp,
  recordFreePredictionIpEvent,
  getFreePredictionIpRisk,
  reserveFreePredictionIp,
  consumeFreePredictionWithIp,
  releaseFreePredictionIp
};

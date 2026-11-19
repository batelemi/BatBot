"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reserveFreePrediction,
  consumeFreePrediction,
  releaseFreePrediction,
  getFreePredictionStatus
} = require("./free-prediction-quota");

function createMockPool() {
  const rows = new Map();

  return {
    rows,

    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      const userId = String(params[0]);

      if (q.startsWith("INSERT INTO free_prediction_quota")) {
        const token = params[1];
        const existing = rows.get(userId);

        if (!existing) {
          rows.set(userId, {
            status: "reserved",
            reservation_token: token,
            reserved_until: Date.now() + 30 * 60 * 1000,
            consumed_at: null
          });
          return { rowCount: 1, rows: [{ user_id: userId }] };
        }

        if (
          existing.status === "reserved" &&
          existing.reserved_until <= Date.now()
        ) {
          existing.reservation_token = token;
          existing.reserved_until = Date.now() + 30 * 60 * 1000;
          return { rowCount: 1, rows: [{ user_id: userId }] };
        }

        return { rowCount: 0, rows: [] };
      }

      if (q.startsWith("SELECT status, reserved_until")) {
        const row = rows.get(userId);
        return {
          rowCount: row ? 1 : 0,
          rows: row ? [{
            status: row.status,
            reserved_until: row.reserved_until
          }] : []
        };
      }

      if (q.startsWith("UPDATE free_prediction_quota")) {
        const row = rows.get(userId);
        if (
          row &&
          row.status === "reserved" &&
          row.reservation_token === params[1]
        ) {
          row.status = "consumed";
          row.reservation_token = null;
          row.reserved_until = null;
          row.consumed_at = new Date();
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (q.startsWith("DELETE FROM free_prediction_quota")) {
        const row = rows.get(userId);
        if (
          row &&
          row.status === "reserved" &&
          row.reservation_token === params[1]
        ) {
          rows.delete(userId);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (q.startsWith("SELECT status, consumed_at")) {
        const row = rows.get(userId);
        return {
          rowCount: row ? 1 : 0,
          rows: row ? [{
            status: row.status,
            consumed_at: row.consumed_at,
            reserved: row.status === "reserved" &&
              row.reserved_until > Date.now()
          }] : []
        };
      }

      throw new Error("Requête SQL non simulée : " + q);
    }
  };
}

test("un compte reçoit une seule réservation gratuite", async () => {
  const pool = createMockPool();

  const first = await reserveFreePrediction(pool, 101);
  assert.equal(first.ok, true);

  const second = await reserveFreePrediction(pool, 101);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_reserved");
});

test("un droit consommé ne peut jamais être réservé à nouveau", async () => {
  const pool = createMockPool();

  const reservation = await reserveFreePrediction(pool, 102);
  assert.equal(reservation.ok, true);

  const consumed = await consumeFreePrediction(
    pool, 102, reservation.token
  );
  assert.equal(consumed, true);

  const status = await getFreePredictionStatus(pool, 102);
  assert.equal(status.used, true);
  assert.equal(status.available, false);

  const next = await reserveFreePrediction(pool, 102);
  assert.equal(next.ok, false);
  assert.equal(next.reason, "already_used");
});

test("une réservation libérée rend le droit disponible", async () => {
  const pool = createMockPool();

  const reservation = await reserveFreePrediction(pool, 103);
  assert.equal(reservation.ok, true);

  const released = await releaseFreePrediction(
    pool, 103, reservation.token
  );
  assert.equal(released, true);

  const status = await getFreePredictionStatus(pool, 103);
  assert.equal(status.used, false);
  assert.equal(status.available, true);
});

test("deux demandes concurrentes ne peuvent pas réserver deux fois", async () => {
  const pool = createMockPool();

  const results = await Promise.all([
    reserveFreePrediction(pool, 104),
    reserveFreePrediction(pool, 104)
  ]);

  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok).length, 1);
});

test("une réservation expirée peut être récupérée, mais son ancien jeton ne peut plus consommer le droit", async () => {
  const pool = createMockPool();

  const first = await reserveFreePrediction(pool, 105);
  assert.equal(first.ok, true);

  // Simule l'expiration des 30 minutes.
  pool.rows.get("105").reserved_until = Date.now() - 1000;

  const second = await reserveFreePrediction(pool, 105);
  assert.equal(second.ok, true);
  assert.notEqual(second.token, first.token);

  const oldConsume = await consumeFreePrediction(pool, 105, first.token);
  assert.equal(oldConsume, false);

  const newConsume = await consumeFreePrediction(pool, 105, second.token);
  assert.equal(newConsume, true);

  const status = await getFreePredictionStatus(pool, 105);
  assert.equal(status.used, true);
  assert.equal(status.available, false);
});

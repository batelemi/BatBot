"use strict";

const assert = require("node:assert/strict");

process.env.IP_HASH_SECRET = "batbot-test-secret-0123456789-abcdef";

const {
  hashClientIp,
  reserveFreePredictionIp,
  consumeFreePredictionWithIp,
  releaseFreePredictionIp
} = require("./free-prediction-ip");

class FakePool {
  constructor() {
    this.ips = new Map();
    this.quotas = new Map();
    this.events = [];
    this.snapshot = null;
    this.failNextIpUpdate = false;
  }

  async query(sql, params = []) {
    return this.execute(sql, params);
  }

  async connect() {
    return {
      query: async (sql, params = []) => this.execute(sql, params),
      release: () => {}
    };
  }

  async execute(sql, p = []) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q === "BEGIN") {
      this.snapshot = {
        ips: new Map([...this.ips].map(([k, v]) => [k, {...v}])),
        quotas: new Map([...this.quotas].map(([k, v]) => [k, {...v}])),
        events: [...this.events]
      };
      return { rowCount: 0, rows: [] };
    }

    if (q === "COMMIT") {
      this.snapshot = null;
      return { rowCount: 0, rows: [] };
    }

    if (q === "ROLLBACK") {
      if (this.snapshot) {
        this.ips = this.snapshot.ips;
        this.quotas = this.snapshot.quotas;
        this.events = this.snapshot.events;
        this.snapshot = null;
      }
      return { rowCount: 0, rows: [] };
    }

    if (q.startsWith("INSERT INTO free_prediction_ip_reservations")) {
      const [ipHash, userId, token, minutes] = p;
      const old = this.ips.get(ipHash);

      if (old && old.expiresAt > Date.now()) {
        return { rowCount: 0, rows: [] };
      }

      this.ips.set(ipHash, {
        userId, token, status: "reserved",
        expiresAt: Date.now() + minutes * 60000
      });

      return { rowCount: 1, rows: [{ token }] };
    }

    if (q.startsWith("SELECT user_id, status FROM free_prediction_ip_reservations")) {
      const row = this.ips.get(p[0]);
      return {
        rowCount: row ? 1 : 0,
        rows: row ? [{ user_id: row.userId, status: row.status }] : []
      };
    }

    if (q.startsWith("DELETE FROM free_prediction_ip_reservations")) {
      const [ipHash, userId, token] = p;
      const row = this.ips.get(ipHash);

      if (row && row.userId === userId &&
          row.token === token && row.status === "reserved") {
        this.ips.delete(ipHash);
        return { rowCount: 1, rows: [{ ip_hash: ipHash }] };
      }

      return { rowCount: 0, rows: [] };
    }

    if (q.startsWith("UPDATE free_prediction_quota")) {
      const [userId, token] = p;
      const row = this.quotas.get(userId);

      if (!row || row.status !== "reserved" || row.token !== token ||
          row.reservedUntil <= Date.now()) {
        return { rowCount: 0, rows: [] };
      }

      row.status = "consumed";
      return { rowCount: 1, rows: [{ user_id: userId }] };
    }

    if (q.startsWith("UPDATE free_prediction_ip_reservations")) {
      if (this.failNextIpUpdate) {
        this.failNextIpUpdate = false;
        return { rowCount: 0, rows: [] };
      }

      const [ipHash, userId, token, days] = p;
      const row = this.ips.get(ipHash);

      if (!row || row.userId !== userId || row.token !== token ||
          row.status !== "reserved" || row.expiresAt <= Date.now()) {
        return { rowCount: 0, rows: [] };
      }

      row.status = "consumed";
      row.expiresAt = Date.now() + days * 86400000;
      return { rowCount: 1, rows: [{ ip_hash: ipHash }] };
    }

    if (q.startsWith("INSERT INTO free_prediction_ip_events")) {
      this.events.push(p);
      return { rowCount: 1, rows: [] };
    }

    throw new Error("Requête SQL non simulée : " + q);
  }
}

(async () => {
  const pool = new FakePool();
  const ipHash = hashClientIp({ ip: "203.0.113.10" });

  assert.ok(ipHash, "L'empreinte IP doit être créée.");

  // 1. Première réservation autorisée.
  const first = await reserveFreePredictionIp(pool, 101, ipHash);
  assert.equal(first.ok, true);

  // 2. Deuxième compte bloqué sur la même IP.
  const second = await reserveFreePredictionIp(pool, 102, ipHash);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ip_used_or_reserved");

  // 3. Échec de génération : libération de la réservation IP.
  assert.equal(
    await releaseFreePredictionIp(pool, 101, ipHash, first.token),
    true
  );

  const retry = await reserveFreePredictionIp(pool, 102, ipHash);
  assert.equal(retry.ok, true);

  const quotaToken = "quota-test-token";
  pool.quotas.set(102, {
    status: "reserved",
    token: quotaToken,
    reservedUntil: Date.now() - 1000
  });

  // 4. Un quota individuel expiré doit être refusé.
  const expired = await consumeFreePredictionWithIp(
    pool, 102, quotaToken, ipHash, retry.token
  );

  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "quota_expired");
  assert.equal(pool.quotas.get(102).status, "reserved");
  assert.equal(pool.ips.get(ipHash).status, "reserved");
  assert.equal(pool.events.length, 0);

  // Réactiver le quota pour les tests suivants.
  pool.quotas.get(102).reservedUntil = Date.now() + 30 * 60 * 1000;

  // 5. Simuler un échec IP après la mise à jour du quota.
  pool.failNextIpUpdate = true;

  const failed = await consumeFreePredictionWithIp(
    pool, 102, quotaToken, ipHash, retry.token
  );

  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "ip_reservation_expired");

  // Le rollback doit restaurer les deux réservations.
  assert.equal(pool.quotas.get(102).status, "reserved");
  assert.equal(pool.ips.get(ipHash).status, "reserved");
  assert.equal(pool.events.length, 0);

  // 5. Nouvelle tentative : les deux consommations réussissent.
  const consumed = await consumeFreePredictionWithIp(
    pool, 102, quotaToken, ipHash, retry.token
  );

  assert.equal(consumed.ok, true);
  assert.equal(pool.quotas.get(102).status, "consumed");
  assert.equal(pool.ips.get(ipHash).status, "consumed");
  assert.equal(pool.events.length, 1);

  // 6. Un troisième compte est bloqué.
  const third = await reserveFreePredictionIp(pool, 103, ipHash);
  assert.equal(third.ok, false);
  assert.equal(third.reason, "already_used");

  console.log("TEST PROTECTION IP BATBOT PRO : OK");
  console.log("Première réservation : OK");
  console.log("Deuxième compte bloqué : OK");
  console.log("Libération après échec : OK");
  console.log("Rollback des deux quotas : OK");
  console.log("Consommation atomique simulée : OK");
  console.log("Troisième compte bloqué : OK");
  console.log("Aucune connexion PostgreSQL ou réseau.");
})().catch(error => {
  console.error("ÉCHEC DU TEST :", error);
  process.exitCode = 1;
});

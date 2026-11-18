"use strict";

const assert = require("node:assert/strict");
const {
  createJekoPayment
} = require("./jeko-payment-service");

process.env.JEKO_API_KEY = "CLE_TEST_FICTIVE";
process.env.JEKO_API_KEY_ID = "ID_TEST_FICTIF";
process.env.JEKO_STORE_ID = "TEST_STORE";

let nextId = 1;
let responseMode = "valid";
let capturedRequest = null;
let realNetworkCalls = 0;

const rateLimitCounts = new Map();

const pool = {
  async query(sql, values = []) {
    if (sql.includes("INSERT INTO jeko_creation_rate_limits")) {
      const userId = String(values[0]);
      const current = rateLimitCounts.get(userId) || 0;

      if (current >= 3) {
        return { rows: [], rowCount: 0 };
      }

      rateLimitCounts.set(userId, current + 1);
      return {
        rows: [{ request_count: current + 1 }],
        rowCount: 1
      };
    }

    if (sql.includes("INSERT INTO jeko_payments")) {
      return {
        rows: [{ id: nextId++ }],
        rowCount: 1
      };
    }

    if (sql.includes("UPDATE jeko_payments")) {
      return {
        rows: [{ id: values[0] }],
        rowCount: 1
      };
    }

    throw new Error("Requête SQL non simulée : " + sql);
  }
};

global.fetch = async (url, options) => {
  realNetworkCalls++;
  capturedRequest = {
    url,
    options,
    body: JSON.parse(options.body)
  };

  let data = {
    id: "jeko-test-uuid-123456",
    storeId: "TEST_STORE",
    reference: capturedRequest.body.reference,
    type: "redirect",
    paymentMethod: capturedRequest.body.paymentDetails.data.paymentMethod,
    status: "pending",
    redirectUrl: "https://pay.jeko.africa/pay_request/pr/jeko-test-uuid-123456"
  };

  if (responseMode === "numeric_id") {
    data.id = 42;
  }

  if (responseMode === "bad_url") {
    data.redirectUrl = "https://faux-site.example/pay";
  }

  if (responseMode === "short_url") {
    data.redirectUrl = "https://pay.jeko.africa/pr/" + data.id;
  }

  if (responseMode === "wrong_id") {
    data.redirectUrl = "https://pay.jeko.africa/pr/autre-identifiant";
  }

  if (responseMode === "credentials_url") {
    data.redirectUrl = "https://utilisateur:secret@pay.jeko.africa/pr/" + data.id;
  }

  return {
    ok: true,
    status: 200,
    async json() {
      return data;
    }
  };
};

async function main() {
  const valid = await createJekoPayment({
    pool,
    userId: 7,
    offer: "Premium 7 jours",
    paymentMethod: "wave"
  });

  assert.equal(valid.amount, 1000);
  assert.equal(valid.offer, "Premium 7 jours");
  assert.equal(
    capturedRequest.url,
    "https://api.jeko.africa/partner_api/payment_requests"
  );
  assert.equal(capturedRequest.body.storeId, "TEST_STORE");
  assert.equal(capturedRequest.body.amountCents, 100000);
  assert.equal(capturedRequest.body.currency, "XOF");
  assert.equal(
    capturedRequest.body.paymentDetails.type,
    "redirect"
  );
  assert.equal(
    capturedRequest.body.paymentDetails.data.paymentMethod,
    "wave"
  );
  assert.match(valid.redirectUrl, /^https:\/\/pay\.jeko\.africa\/pay_request\//);

  console.log("TEST 1 : identifiant textuel et URL officielle — RÉUSSI");
  console.log("TEST 2 : montant et méthode transmis correctement — RÉUSSI");

  responseMode = "short_url";
  const shortPath = await createJekoPayment({
    pool, userId: 8, offer: "Premium 7 jours", paymentMethod: "wave"
  });
  assert.equal(shortPath.redirectUrl, "https://pay.jeko.africa/pr/jeko-test-uuid-123456");
  console.log("TEST 6 : chemin court /pr/{id} accepté — RÉUSSI");

  responseMode = "wrong_id";
  await assert.rejects(
    createJekoPayment({
      pool, userId: 9, offer: "Premium 7 jours", paymentMethod: "wave"
    }),
    error => error.statusCode === 502
  );
  console.log("TEST 7 : identifiant différent rejeté — RÉUSSI");

  responseMode = "credentials_url";
  await assert.rejects(
    createJekoPayment({
      pool, userId: 10, offer: "Premium 7 jours", paymentMethod: "wave"
    }),
    error => error.statusCode === 502
  );
  console.log("TEST 8 : URL contenant des identifiants rejetée — RÉUSSI");

  responseMode = "numeric_id";

  await assert.rejects(
    createJekoPayment({
      pool,
      userId: 7,
      offer: "Premium 7 jours",
      paymentMethod: "wave"
    }),
    error => error.statusCode === 502
  );

  console.log("TEST 3 : identifiant numérique rejeté — RÉUSSI");

  responseMode = "bad_url";

  await assert.rejects(
    createJekoPayment({
      pool,
      userId: 7,
      offer: "Premium 7 jours",
      paymentMethod: "wave"
    }),
    error => error.statusCode === 502
  );

  console.log("TEST 4 : URL externe frauduleuse rejetée — RÉUSSI");
  const fetchesBeforeLimit = realNetworkCalls;

  await assert.rejects(
    createJekoPayment({
      pool,
      userId: 7,
      offer: "Premium 7 jours",
      paymentMethod: "wave"
    }),
    error => error.statusCode === 429
  );

  assert.equal(realNetworkCalls, fetchesBeforeLimit);
  assert.equal(rateLimitCounts.get("7"), 3);

  console.log("TEST 5 : quatrième demande bloquée après trois tentatives — RÉUSSI");
  console.log("Demandes autorisées dans la fenêtre :", rateLimitCounts.get("7"));

  console.log("Appels réseau réels :", 0);
  console.log("Requêtes fetch simulées :", realNetworkCalls);
  console.log("Clés utilisées : uniquement fictives");
}

main().catch(error => {
  console.error("ÉCHEC DU TEST :", error.message);
  process.exitCode = 1;
});

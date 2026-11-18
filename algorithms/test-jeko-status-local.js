"use strict";

const assert = require("assert");
const {
  checkJekoPaymentStatus
} = require("./jeko-payment-service");

process.env.JEKO_API_KEY = "FAKE_TEST_API_KEY";
process.env.JEKO_API_KEY_ID = "FAKE_TEST_API_KEY_ID";

const originalFetch = global.fetch;

function makePayment(overrides = {}) {
  return {
    id: 101,
    user_id: "7",
    reference: "BATBOT-TEST-REFERENCE",
    jeko_payment_id: "jeko-payment-test-123",
    store_id: "FAKE_STORE",
    payment_method: "wave",
    amount_cents: 100000,
    currency: "XOF",
    status: "pending",
    provider_status: "pending",
    status_check_after: null,
    ...overrides
  };
}

function makePool(payment) {
  const state = {
    payment: { ...payment },
    queries: [],
    premiumQueries: 0
  };

  return {
    state,

    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      state.queries.push(normalized);

      if (normalized.includes("WHERE user_id = $1 AND reference = $2")) {
        if (
          state.payment.user_id !== String(params[0]) ||
          state.payment.reference !== params[1]
        ) {
          return { rows: [], rowCount: 0 };
        }

        return { rows: [{ ...state.payment }], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE jeko_payments") &&
          normalized.includes("SET status_check_after = NOW() + INTERVAL '60 seconds'")) {
        const p = state.payment;
        const available =
          !p.status_check_after ||
          new Date(p.status_check_after) <= new Date();

        if (
          p.id === params[0] &&
          p.user_id === String(params[1]) &&
          p.status === "pending" &&
          available
        ) {
          p.status_check_after = new Date(Date.now() + 60000);
          return { rows: [{ id: p.id }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith("SELECT status, provider_status, status_check_after")) {
        return {
          rows: [{
            status: state.payment.status,
            provider_status: state.payment.provider_status,
            status_check_after: state.payment.status_check_after
          }],
          rowCount: 1
        };
      }

      if (normalized.startsWith("UPDATE jeko_payments") &&
          normalized.includes("SET status = 'failed'")) {
        if (state.payment.status !== "pending") {
          return { rows: [], rowCount: 0 };
        }

        state.payment.status = "failed";
        state.payment.provider_status = "error";
        state.payment.status_check_after = null;
        return { rows: [{ id: state.payment.id }], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE jeko_payments") &&
          normalized.includes("SET provider_status = 'status_check_error'")) {
        state.payment.provider_status = "status_check_error";
        state.payment.status_check_after =
          new Date(Date.now() + Number(params[1]) * 1000);
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE jeko_payments") &&
          (normalized.includes("SET provider_status = 'invalid_status_response'") ||
           normalized.includes("SET provider_status = 'invalid_success_response'"))) {
        state.payment.provider_status =
          normalized.includes("invalid_success_response")
            ? "invalid_success_response"
            : "invalid_status_response";
        state.payment.status_check_after =
          new Date(Date.now() + 60000);
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE jeko_payments") &&
          normalized.includes("SET provider_status = $2")) {
        state.payment.provider_status = params[1];
        state.payment.status_check_after =
          new Date(Date.now() + Number(params[2]) * 1000);
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("SELECT status, provider_status FROM jeko_payments")) {
        return {
          rows: [{
            status: state.payment.status,
            provider_status: state.payment.provider_status
          }],
          rowCount: 1
        };
      }

      if (/\busers\b/i.test(normalized)) {
        state.premiumQueries++;
      }

      throw new Error("Requête SQL inattendue dans le test : " + normalized);
    }
  };
}

function makeResponse(data, options = {}) {
  const headers = {
    get(name) {
      return name.toLowerCase() === "retry-after"
        ? (options.retryAfter || null)
        : null;
    }
  };

  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers,
    async json() {
      return data;
    }
  };
}

function providerResponse(status, overrides = {}) {
  return {
    id: "jeko-payment-test-123",
    storeId: "FAKE_STORE",
    reference: "BATBOT-TEST-REFERENCE",
    type: "redirect",
    paymentMethod: "wave",
    status,
    ...overrides
  };
}

async function run() {
  let fetchCalls = 0;
  let responseFactory = () =>
    makeResponse(providerResponse("pending"), { retryAfter: "45" });

  global.fetch = async (url, options) => {
    fetchCalls++;
    assert(
      url.endsWith("/jeko-payment-test-123"),
      "L'URL doit utiliser l'identifiant Jèko enregistré"
    );
    assert.strictEqual(options.method, "GET");
    assert.strictEqual(options.headers["X-API-KEY"], "FAKE_TEST_API_KEY");
    assert.strictEqual(options.headers["X-API-KEY-ID"], "FAKE_TEST_API_KEY_ID");
    return responseFactory();
  };

  try {
    // 1. Paiement en attente et respect de Retry-After.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;
      responseFactory = () =>
        makeResponse(providerResponse("pending"), { retryAfter: "45" });

      const result = await checkJekoPaymentStatus({
        pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
      });

      assert.strictEqual(result.status, "pending");
      assert.strictEqual(result.retryAfterSeconds, 45);
      assert.strictEqual(fetchCalls, 1);
      console.log("TEST 1 — Paiement pending et Retry-After : RÉUSSI");
    }

    // 2. Une deuxième consultation immédiate ne rappelle pas Jèko.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;
      responseFactory = () =>
        makeResponse(providerResponse("pending"), { retryAfter: "60" });

      await checkJekoPaymentStatus({
        pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
      });

      const second = await checkJekoPaymentStatus({
        pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
      });

      assert.strictEqual(fetchCalls, 1);
      assert.strictEqual(second.status, "pending");
      assert(second.retryAfterSeconds > 0);
      console.log("TEST 2 — Protection contre les consultations répétées : RÉUSSI");
    }

    // 3. Paiement échoué.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;
      responseFactory = () =>
        makeResponse(providerResponse("error"));

      const result = await checkJekoPaymentStatus({
        pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
      });

      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.premiumActivated, false);
      assert.strictEqual(pool.state.payment.status, "failed");
      assert.strictEqual(pool.state.premiumQueries, 0);
      console.log("TEST 3 — Paiement error : RÉUSSI");
    }

    // 4. Jèko indique success, mais le webhook reste obligatoire.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;
      responseFactory = () =>
        makeResponse(providerResponse("success", {
          transaction: {
            status: "success",
            amount: { amount: 100000, currency: "XOF" }
          }
        }));

      const result = await checkJekoPaymentStatus({
        pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
      });

      assert.strictEqual(result.status, "pending");
      assert.strictEqual(result.awaitingWebhook, true);
      assert.strictEqual(result.premiumActivated, false);
      assert.strictEqual(pool.state.payment.status, "pending");
      assert.strictEqual(pool.state.premiumQueries, 0);
      console.log("TEST 4 — Success sans webhook : Premium non activé : RÉUSSI");
    }

    // 5. Un autre utilisateur ne peut pas consulter cette référence.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;

      await assert.rejects(
        checkJekoPaymentStatus({
          pool, userId: 8, reference: "BATBOT-TEST-REFERENCE"
        }),
        error => error.statusCode === 404
      );

      assert.strictEqual(fetchCalls, 0);
      console.log("TEST 5 — Isolation entre utilisateurs : RÉUSSI");
    }

    // 6. Un paiement déjà payé ne déclenche aucune consultation externe.
    {
      const pool = makePool(makePayment({
        status: "paid",
        provider_status: "success"
      }));
      fetchCalls = 0;

      const result = await checkJekoPaymentStatus({
        pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
      });

      assert.strictEqual(result.status, "paid");
      assert.strictEqual(result.premiumActivated, true);
      assert.strictEqual(fetchCalls, 0);
      console.log("TEST 6 — Paiement déjà confirmé : RÉUSSI");
    }

    // 7. Une référence différente dans la réponse Jèko est rejetée.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;
      responseFactory = () =>
        makeResponse(providerResponse("pending", {
          reference: "AUTRE-REFERENCE"
        }));

      await assert.rejects(
        checkJekoPaymentStatus({
          pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
        }),
        error => error.statusCode === 502
      );

      assert.strictEqual(pool.state.payment.status, "pending");
      assert.strictEqual(
        pool.state.payment.provider_status,
        "invalid_status_response"
      );
      console.log("TEST 7 — Réponse avec référence falsifiée : RÉUSSI");
    }

    // 8. Une erreur HTTP 429 respecte Retry-After.
    {
      const pool = makePool(makePayment());
      fetchCalls = 0;
      responseFactory = () =>
        makeResponse({ error: "rate limited" }, {
          ok: false,
          status: 429,
          retryAfter: "90"
        });

      await assert.rejects(
        checkJekoPaymentStatus({
          pool, userId: 7, reference: "BATBOT-TEST-REFERENCE"
        }),
        error => error.statusCode === 502
      );

      const delay = Math.ceil(
        (pool.state.payment.status_check_after.getTime() - Date.now()) / 1000
      );

      assert(delay >= 89 && delay <= 90);
      assert.strictEqual(pool.state.payment.status, "pending");
      console.log("TEST 8 — Erreur HTTP 429 et Retry-After : RÉUSSI");
    }

    console.log("\nBILAN : 8 tests réussis.");
    console.log("Réseau réel : 0 appel.");
    console.log("Base PostgreSQL réelle : 0 connexion.");
    console.log("Clés utilisées : uniquement des valeurs fictives.");
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch(error => {
  console.error("\nÉCHEC DU TEST :", error);
  process.exitCode = 1;
});

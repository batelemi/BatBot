"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  handleJekoWebhook
} = require("./jeko-payment-service");

process.env.JEKO_WEBHOOK_SECRET = "secret-test-batbot";
process.env.JEKO_STORE_ID = "TEST_STORE";

const state = {
  payment: {
    id: 42,
    user_id: 7,
    offer: "Premium 7 jours",
    amount_xof: 1000,
    amount_cents: 100000,
    currency: "XOF",
    payment_method: "wave",
    reference: "BATBOT-TEST-REF",
    jeko_payment_id: "JEKO-REQ-42",
    jeko_transaction_id: null,
    store_id: "TEST_STORE",
    status: "pending"
  },
  premiumUntil: null,
  premiumUpdates: 0,
  events: new Set()
};

const client = {
  async query(sql, values = []) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(q)) {
      return { rows: [], rowCount: 0 };
    }

    if (q.includes("SELECT * FROM jeko_payments")) {
      const matches =
        state.payment.jeko_payment_id === values[0] ||
        (
          state.payment.jeko_payment_id === null &&
          state.payment.reference === values[1]
        );

      return {
        rows: matches ? [{ ...state.payment }] : [],
        rowCount: matches ? 1 : 0
      };
    }

    if (q.includes("SELECT id FROM jeko_payments")) {
      const found =
        state.payment.jeko_transaction_id === values[0];

      return {
        rows: found ? [{ id: state.payment.id }] : [],
        rowCount: found ? 1 : 0
      };
    }

    if (q.includes("INSERT INTO jeko_webhook_events")) {
      const eventKey = values[0];

      if (state.events.has(eventKey)) {
        return { rows: [], rowCount: 0 };
      }

      state.events.add(eventKey);
      return {
        rows: [{ event_key: eventKey }],
        rowCount: 1
      };
    }

    if (q.includes("SELECT payment_id FROM jeko_webhook_events")) {
      return {
        rows: state.events.has(values[0])
          ? [{ payment_id: state.payment.id }]
          : [],
        rowCount: state.events.has(values[0]) ? 1 : 0
      };
    }

    if (q.includes("SELECT premium_until FROM users")) {
      return {
        rows: [{ premium_until: state.premiumUntil }],
        rowCount: 1
      };
    }

    if (q.includes("UPDATE users")) {
      state.premiumUntil = values[1];
      state.premiumUpdates += 1;
      return { rows: [], rowCount: 1 };
    }

    if (q.includes("UPDATE jeko_payments")) {
      state.payment.status = "paid";
      state.payment.jeko_payment_id =
        state.payment.jeko_payment_id || values[1];
      state.payment.jeko_transaction_id = values[2];
      state.payment.provider_status = values[3];
      return { rows: [], rowCount: 1 };
    }

    throw new Error("Requête SQL non simulée dans le test : " + q);
  },

  release() {}
};

const pool = {
  async connect() {
    return client;
  }
};

async function main() {
  const payload = {
    id: "JEKO-TRANSACTION-42",
    transactionType: "payment",
    status: "success",
    storeId: "TEST_STORE",
    paymentMethod: "wave",
    amount: {
      amount: 100000,
      currency: "XOF"
    },
    transactionDetails: {
      id: "JEKO-REQ-42",
      reference: "BATBOT-TEST-REF"
    }
  };

  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", process.env.JEKO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const first = await handleJekoWebhook({
    pool,
    rawBody,
    signature,
    eventName: "TRANSACTION_COMPLETED"
  });

  assert.equal(first.ok, true);
  assert.equal(first.activated, true);
  assert.equal(state.payment.status, "paid");
  assert.equal(state.payment.jeko_transaction_id, payload.id);
  assert.equal(state.premiumUpdates, 1);
  assert.ok(state.premiumUntil);

  const firstExpiration = new Date(state.premiumUntil);
  const durationDays =
    (firstExpiration.getTime() - Date.now()) / 86400000;

  assert.ok(
    durationDays > 6.99 && durationDays < 7.01,
    "Le Premium doit être activé pour environ 7 jours."
  );

  const second = await handleJekoWebhook({
    pool,
    rawBody,
    signature,
    eventName: "TRANSACTION_COMPLETED"
  });

  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(state.premiumUpdates, 1);
  assert.equal(
    new Date(state.premiumUntil).getTime(),
    firstExpiration.getTime()
  );

  console.log("TEST 1 : activation Premium — RÉUSSI");
  console.log("TEST 2 : durée de 7 jours — RÉUSSI");
  console.log("TEST 3 : webhook répété sans double activation — RÉUSSI");
  console.log("Nombre de mises à jour Premium :", state.premiumUpdates);
  console.log("Appels réseau réels : 0");
  console.log("Connexion PostgreSQL réelle : 0");
}

main().catch(error => {
  console.error("ÉCHEC DU TEST :", error.message);
  process.exitCode = 1;
});

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  handleJekoWebhook
} = require("./jeko-payment-service");

process.env.JEKO_WEBHOOK_SECRET = "secret-test-batbot";
process.env.JEKO_STORE_ID = "TEST_STORE";

let connectionCount = 0;
let premiumUpdates = 0;
let rollbackCount = 0;

const payment = {
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
};

const client = {
  async query(sql) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q === "BEGIN" || q === "COMMIT") {
      return { rows: [], rowCount: 0 };
    }

    if (q === "ROLLBACK") {
      rollbackCount++;
      return { rows: [], rowCount: 0 };
    }

    if (q.includes("SELECT * FROM jeko_payments")) {
      return { rows: [{ ...payment }], rowCount: 1 };
    }

    if (q.includes("UPDATE users")) {
      premiumUpdates++;
      return { rows: [], rowCount: 1 };
    }

    throw new Error("Requête inattendue dans le test : " + q);
  },

  release() {}
};

const pool = {
  async connect() {
    connectionCount++;
    return client;
  }
};

function makePayload(overrides = {}) {
  return {
    id: "JEKO-SECURITY-TEST",
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
    },
    ...overrides
  };
}

function sign(rawBody) {
  return crypto
    .createHmac("sha256", process.env.JEKO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
}

async function mustReject(label, payload, expectedMessage, options = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = options.badSignature
    ? "signature-fausse"
    : sign(rawBody);

  await assert.rejects(
    handleJekoWebhook({
      pool,
      rawBody,
      signature,
      eventName: "TRANSACTION_COMPLETED"
    }),
    error => {
      assert.ok(
        error.message.includes(expectedMessage),
        `${label} : message inattendu : ${error.message}`
      );
      return true;
    }
  );

  console.log(label + " — REJETÉ COMME PRÉVU");
}

async function main() {
  await mustReject(
    "TEST 1 : signature falsifiée",
    makePayload(),
    "Signature Jèko invalide",
    { badSignature: true }
  );

  assert.equal(connectionCount, 0);

  await mustReject(
    "TEST 2 : magasin non reconnu",
    makePayload({ storeId: "FAUX_STORE" }),
    "Magasin Jèko non reconnu"
  );

  assert.equal(connectionCount, 0);

  await mustReject(
    "TEST 3 : montant différent",
    makePayload({
      amount: { amount: 200000, currency: "XOF" }
    }),
    "ne correspondent pas"
  );

  await mustReject(
    "TEST 4 : moyen de paiement différent",
    makePayload({ paymentMethod: "orange" }),
    "ne correspondent pas"
  );

  await mustReject(
    "TEST 5 : référence différente",
    makePayload({
      transactionDetails: {
        id: "JEKO-REQ-42",
        reference: "AUTRE-REFERENCE"
      }
    }),
    "ne correspondent pas"
  );

  assert.equal(premiumUpdates, 0);
  assert.equal(rollbackCount, 3);

  const ignoredPayload = makePayload({ status: "pending" });
  const ignoredBody = Buffer.from(JSON.stringify(ignoredPayload));

  const ignored = await handleJekoWebhook({
    pool,
    rawBody: ignoredBody,
    signature: sign(ignoredBody),
    eventName: "TRANSACTION_COMPLETED"
  });

  assert.equal(ignored.ok, true);
  assert.equal(ignored.ignored, true);

  console.log("TEST 6 : transaction non terminée — IGNORÉE");
  console.log("Activations Premium déclenchées :", premiumUpdates);
  console.log("Annulations SQL après incohérence :", rollbackCount);
  console.log("Aucun compte Premium activé par les faux paiements.");
}

main().catch(error => {
  console.error("ÉCHEC DU TEST :", error.message);
  process.exitCode = 1;
});

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API_URL = "https://api.jeko.africa/partner_api/payment_requests";
const PUBLIC_URL = "https://batbot.pro";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PG_BIGINT = 9223372036854775807n;

const PREMIUM_OFFERS = Object.freeze({
  "Premium 7 jours": { amount: 1000, days: 7 },
  "Premium 14 jours": { amount: 2000, days: 14 },
  "Premium 21 jours": { amount: 3000, days: 21 }
});

const PAYMENT_METHODS = new Set([
  "orange", "wave", "mtn", "moov", "djamo"
]);

function serviceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validUserId(value) {
  try {
    const id = BigInt(String(value));
    return id > 0n && id <= MAX_PG_BIGINT;
  } catch (_) {
    return false;
  }
}

function validJekoRedirectUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "pay.jeko.africa" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.startsWith("/pay_request/")
    );
  } catch (_) {
    return false;
  }
}

async function initializeJekoPayments(pool) {
  const schemaPath = path.join(
    __dirname, "..", "database", "jeko-payments-schema.sql"
  );
  const schema = fs.readFileSync(schemaPath, "utf8");
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(schema);
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateCreationState(pool, paymentId, status, providerStatus) {
  try {
    await pool.query(
      `UPDATE jeko_payments
       SET status = $2, provider_status = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [paymentId, status, providerStatus]
    );
  } catch (error) {
    console.error("BATBOT JEKO: impossible de mettre à jour la demande :", error.message);
  }
}

async function reserveJekoCreationSlot(pool, userId) {
  const result = await pool.query(
    `INSERT INTO jeko_creation_rate_limits (
       user_id, window_started_at, request_count, updated_at
     )
     VALUES ($1, NOW(), 1, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       window_started_at = CASE
         WHEN jeko_creation_rate_limits.window_started_at
              <= NOW() - INTERVAL '10 minutes'
         THEN NOW()
         ELSE jeko_creation_rate_limits.window_started_at
       END,
       request_count = CASE
         WHEN jeko_creation_rate_limits.window_started_at
              <= NOW() - INTERVAL '10 minutes'
         THEN 1
         ELSE jeko_creation_rate_limits.request_count + 1
       END,
       updated_at = NOW()
     WHERE jeko_creation_rate_limits.window_started_at
           <= NOW() - INTERVAL '10 minutes'
        OR jeko_creation_rate_limits.request_count < 3
     RETURNING request_count`,
    [String(userId)]
  );

  if (result.rowCount !== 1) {
    throw serviceError(
      "Vous avez atteint la limite de 3 demandes de paiement Jèko en 10 minutes. Veuillez patienter avant de réessayer.",
      429
    );
  }
}

async function createJekoPayment({
  pool,
  userId,
  offer,
  paymentMethod
}) {
  const normalizedOffer = String(offer || "").trim();
  const selectedOffer = PREMIUM_OFFERS[normalizedOffer];
  const method = String(paymentMethod || "").trim().toLowerCase();

  if (!validUserId(userId)) {
    throw serviceError("Session utilisateur invalide.", 401);
  }

  if (!selectedOffer || !PAYMENT_METHODS.has(method)) {
    throw serviceError("Formule ou moyen de paiement Jèko invalide.");
  }

  const apiKey = String(process.env.JEKO_API_KEY || "").trim();
  const apiKeyId = String(process.env.JEKO_API_KEY_ID || "").trim();
  const storeId = String(process.env.JEKO_STORE_ID || "").trim();

  if (!apiKey || !apiKeyId || !storeId) {
    throw serviceError(
      "Le service de paiement Jèko n'est pas encore configuré.",
      503
    );
  }

  await reserveJekoCreationSlot(pool, userId);

  const amount = selectedOffer.amount;
  const amountCents = amount * 100;
  const reference =
    "BATBOT-" +
    Date.now() +
    "-" +
    crypto.randomBytes(8).toString("hex").toUpperCase();

  const successUrl =
    `${PUBLIC_URL}/?jeko=success&reference=${encodeURIComponent(reference)}`;
  const errorUrl =
    `${PUBLIC_URL}/?jeko=error&reference=${encodeURIComponent(reference)}`;

  const inserted = await pool.query(
    `INSERT INTO jeko_payments (
       user_id, offer, amount_xof, amount_cents, currency,
       payment_method, reference, store_id
     )
     VALUES ($1, $2, $3, $4, 'XOF', $5, $6, $7)
     RETURNING id`,
    [
      String(userId),
      normalizedOffer,
      amount,
      amountCents,
      method,
      reference,
      storeId
    ]
  );

  const paymentId = inserted.rows[0].id;

  let response;

  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "X-API-KEY-ID": apiKeyId,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        storeId,
        amountCents,
        currency: "XOF",
        reference,
        paymentDetails: {
          type: "redirect",
          data: {
            paymentMethod: method,
            successUrl,
            errorUrl
          }
        }
      })
    });
  } catch (error) {
    await updateCreationState(
      pool, paymentId, "pending", "creation_unknown"
    );
    throw serviceError(
      "La réponse de Jèko est incertaine. Ne relancez pas immédiatement un autre paiement ; contactez le Service BATBOT PRO si nécessaire.",
      502
    );
  }

  let data = null;

  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok) {
    const definitiveClientError =
      response.status >= 400 && response.status < 500;

    await updateCreationState(
      pool,
      paymentId,
      definitiveClientError ? "failed" : "pending",
      `http_${response.status}`
    );

    throw serviceError(
      "Jèko n'a pas pu confirmer la création de la demande de paiement.",
      502
    );
  }

  const responseChecks = {
    dataPresent: Boolean(data && typeof data === "object"),
    idIsString: typeof data?.id === "string",
    idNotEmpty: typeof data?.id === "string" && Boolean(data.id.trim()),
    storeIdMatches: data?.storeId === storeId,
    referenceMatches: data?.reference === reference,
    typeIsRedirect: data?.type === "redirect",
    paymentMethodMatches: data?.paymentMethod === method,
    statusIsPending: data?.status === "pending",
    redirectUrlIsValid: validJekoRedirectUrl(data?.redirectUrl)
  };

  if (Object.values(responseChecks).some(ok => !ok)) {
    console.warn("BATBOT JEKO CREATE RESPONSE CHECKS:", {
      httpStatus: response.status,
      checks: responseChecks,
      redirectUrlDiagnostics: (() => {
        const value = data?.redirectUrl;
        if (typeof value !== "string") {
          return { valueType: typeof value, parseable: false };
        }
        try {
          const url = new URL(value);
          return {
            parseable: true,
            protocol: url.protocol,
            hostname: url.hostname,
            hasPort: Boolean(url.port),
            hasCredentials: Boolean(url.username || url.password),
            pathStartsCorrectly: url.pathname.startsWith("/pay_request/"),
            pathSegmentCount: url.pathname.split("/").filter(Boolean).length,
            pathShape: url.pathname.split("/").filter(Boolean)
              .map(segment => ["pay_request", "pr"].includes(segment) ? segment : "<other>")
              .join("/")
          };
        } catch (_) {
          return { valueType: "string", parseable: false };
        }
      })(),
      responseKeys: data && typeof data === "object"
        ? Object.keys(data).slice(0, 20)
        : []
    });

    await updateCreationState(
      pool, paymentId, "pending", "invalid_provider_response"
    );
    throw serviceError(
      "La réponse de Jèko n'a pas passé les contrôles de sécurité.",
      502
    );
  }

  const saved = await pool.query(
    `UPDATE jeko_payments
     SET jeko_payment_id = $2,
         redirect_url = $3,
         provider_status = $4,
         updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [paymentId, data.id, data.redirectUrl, data.status]
  );

  if (saved.rowCount !== 1) {
    throw serviceError(
      "La demande Jèko a été créée mais son enregistrement local doit être vérifié.",
      502
    );
  }

  return {
    id: paymentId,
    reference,
    redirectUrl: data.redirectUrl,
    offer: normalizedOffer,
    amount
  };
}


async function checkJekoPaymentStatus({ pool, userId, reference }) {
  if (!validUserId(userId)) {
    throw serviceError("Session utilisateur invalide.", 401);
  }

  const paymentReference = String(reference || "").trim();

  if (!paymentReference || paymentReference.length > 100) {
    throw serviceError("Référence de paiement invalide.");
  }

  const localResult = await pool.query(
    `SELECT id, user_id, reference, jeko_payment_id, store_id,
            payment_method, amount_cents, currency, status,
            provider_status, status_check_after
     FROM jeko_payments
     WHERE user_id = $1 AND reference = $2
     LIMIT 1`,
    [String(userId), paymentReference]
  );

  if (localResult.rows.length !== 1) {
    throw serviceError("Demande de paiement introuvable.", 404);
  }

  const payment = localResult.rows[0];

  if (payment.status !== "pending") {
    return {
      ok: true,
      status: payment.status,
      providerStatus: payment.provider_status,
      premiumActivated: payment.status === "paid"
    };
  }

  if (!payment.jeko_payment_id) {
    return {
      ok: true,
      status: "pending",
      providerStatus: payment.provider_status,
      retryAfterSeconds: 30
    };
  }

  const apiKey = String(process.env.JEKO_API_KEY || "").trim();
  const apiKeyId = String(process.env.JEKO_API_KEY_ID || "").trim();

  if (!apiKey || !apiKeyId) {
    throw serviceError("Le service de consultation Jèko n'est pas configuré.", 503);
  }

  const currentCheckAfter = payment.status_check_after
    ? new Date(payment.status_check_after)
    : null;

  if (currentCheckAfter && currentCheckAfter > new Date()) {
    return {
      ok: true,
      status: "pending",
      providerStatus: payment.provider_status,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((currentCheckAfter.getTime() - Date.now()) / 1000)
      )
    };
  }

  const reservation = await pool.query(
    `UPDATE jeko_payments
     SET status_check_after = NOW() + INTERVAL '60 seconds',
         updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND status = 'pending'
       AND (
         status_check_after IS NULL
         OR status_check_after <= NOW()
       )
     RETURNING id`,
    [payment.id, String(userId)]
  );

  if (reservation.rowCount !== 1) {
    const latest = await pool.query(
      `SELECT status, provider_status, status_check_after
       FROM jeko_payments
       WHERE id = $1 AND user_id = $2`,
      [payment.id, String(userId)]
    );

    if (!latest.rows.length) {
      throw serviceError("Demande de paiement introuvable.", 404);
    }

    const row = latest.rows[0];
    const nextCheck = row.status_check_after
      ? new Date(row.status_check_after)
      : null;

    return {
      ok: true,
      status: row.status,
      providerStatus: row.provider_status,
      premiumActivated: row.status === "paid",
      retryAfterSeconds: nextCheck && nextCheck > new Date()
        ? Math.max(1, Math.ceil((nextCheck.getTime() - Date.now()) / 1000))
        : 30
    };
  }

  const retryAfter = response => {
    const value = response.headers?.get?.("Retry-After");
    const seconds = Number(value);

    if (value && Number.isFinite(seconds) && seconds > 0) {
      return Math.min(3600, Math.max(1, Math.ceil(seconds)));
    }

    if (value) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) {
        return Math.min(3600, Math.max(1, Math.ceil((date - Date.now()) / 1000)));
      }
    }

    return 60;
  };

  let response;

  try {
    response = await fetch(
      API_URL + "/" + encodeURIComponent(payment.jeko_payment_id),
      {
        method: "GET",
        headers: {
          "X-API-KEY": apiKey,
          "X-API-KEY-ID": apiKeyId,
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    );
  } catch (error) {
    await pool.query(
      `UPDATE jeko_payments
       SET provider_status = 'status_check_error',
           status_check_after = NOW() + INTERVAL '60 seconds',
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [payment.id]
    );

    throw serviceError("Impossible de consulter le statut auprès de Jèko. Réessayez plus tard.", 502);
  }

  let data = null;

  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok) {
    const delay = retryAfter(response);

    await pool.query(
      `UPDATE jeko_payments
       SET provider_status = 'status_check_error',
           status_check_after = NOW() + ($2 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [payment.id, delay]
    );

    throw serviceError("Jèko n'a pas pu fournir le statut de cette demande.", 502);
  }

  if (
    !data ||
    data.id !== payment.jeko_payment_id ||
    data.storeId !== payment.store_id ||
    data.reference !== payment.reference ||
    data.type !== "redirect" ||
    data.paymentMethod !== payment.payment_method ||
    !["pending", "success", "error"].includes(data.status)
  ) {
    await pool.query(
      `UPDATE jeko_payments
       SET provider_status = 'invalid_status_response',
           status_check_after = NOW() + INTERVAL '60 seconds',
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [payment.id]
    );

    throw serviceError("La réponse de consultation Jèko n'a pas passé les contrôles de sécurité.", 502);
  }

  if (
    data.status === "success" &&
    (
      !data.transaction ||
      data.transaction.status !== "success" ||
      !data.transaction.amount ||
      Number(data.transaction.amount.amount) !== Number(payment.amount_cents) ||
      data.transaction.amount.currency !== payment.currency
    )
  ) {
    await pool.query(
      `UPDATE jeko_payments
       SET provider_status = 'invalid_success_response',
           status_check_after = NOW() + INTERVAL '60 seconds',
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [payment.id]
    );

    throw serviceError("Les détails du paiement confirmé par Jèko sont incohérents.", 502);
  }

  if (data.status === "error") {
    const failed = await pool.query(
      `UPDATE jeko_payments
       SET status = 'failed',
           provider_status = 'error',
           status_check_after = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [payment.id]
    );

    if (failed.rowCount === 1) {
      return {
        ok: true,
        status: "failed",
        providerStatus: "error",
        premiumActivated: false
      };
    }
  } else {
    const delay = data.status === "pending" ? retryAfter(response) : 300;

    await pool.query(
      `UPDATE jeko_payments
       SET provider_status = $2,
           status_check_after = NOW() + ($3 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [payment.id, data.status, delay]
    );
  }

  const finalResult = await pool.query(
    `SELECT status, provider_status
     FROM jeko_payments
     WHERE id = $1 AND user_id = $2`,
    [payment.id, String(userId)]
  );

  if (!finalResult.rows.length) {
    throw serviceError("Demande de paiement introuvable.", 404);
  }

  const finalPayment = finalResult.rows[0];

  return {
    ok: true,
    status: finalPayment.status,
    providerStatus: finalPayment.provider_status,
    premiumActivated: finalPayment.status === "paid",
    awaitingWebhook: data.status === "success" && finalPayment.status === "pending",
    retryAfterSeconds: data.status === "pending" ? retryAfter(response) : 300
  };
}

function verifyJekoSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret || !signature) {
    return false;
  }

  const received = String(signature).trim();

  if (!/^[a-f0-9]{64}$/.test(received)) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest();

  const supplied = Buffer.from(received, "hex");

  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(expected, supplied)
  );
}

async function handleJekoWebhook({
  pool,
  rawBody,
  signature,
  eventName
}) {
  const secret = String(process.env.JEKO_WEBHOOK_SECRET || "").trim();

  if (!secret) {
    throw serviceError("Secret webhook Jèko non configuré.", 503);
  }

  if (!verifyJekoSignature(rawBody, signature, secret)) {
    throw serviceError("Signature Jèko invalide.", 401);
  }

  if (eventName !== "TRANSACTION_COMPLETED") {
    return { ok: true, ignored: true };
  }

  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (_) {
    throw serviceError("Corps du webhook Jèko invalide.", 400);
  }

  if (
    payload.transactionType !== "payment" ||
    payload.status !== "success"
  ) {
    return { ok: true, ignored: true };
  }

  const transactionId = String(payload.id || "").trim();
  const details = payload.transactionDetails || {};
  const paymentRequestId = String(details.id || "").trim();
  const transactionReference =
    details.reference == null ? null : String(details.reference).trim();

  if (
    !transactionId ||
    !paymentRequestId ||
    transactionId.length > 200 ||
    paymentRequestId.length > 200
  ) {
    throw serviceError("Identifiants de transaction Jèko manquants.");
  }

  const expectedStoreId = String(
    process.env.JEKO_STORE_ID || ""
  ).trim();

  if (!expectedStoreId || payload.storeId !== expectedStoreId) {
    throw serviceError("Magasin Jèko non reconnu.", 403);
  }

  if (
    !payload.amount ||
    payload.amount.currency !== "XOF" ||
    !Number.isSafeInteger(payload.amount.amount) ||
    payload.amount.amount <= 0
  ) {
    throw serviceError("Montant reçu de Jèko invalide.");
  }

  const method = String(payload.paymentMethod || "").toLowerCase();

  if (!PAYMENT_METHODS.has(method)) {
    throw serviceError("Moyen de paiement reçu de Jèko invalide.");
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `SELECT *
       FROM jeko_payments
       WHERE jeko_payment_id = $1
          OR (reference = $2 AND jeko_payment_id IS NULL)
       FOR UPDATE`,
      [paymentRequestId, transactionReference]
    );

    if (result.rows.length !== 1) {
      throw serviceError(
        "Demande de paiement Jèko introuvable ou ambiguë.",
        404
      );
    }

    const payment = result.rows[0];

    if (
      payment.store_id !== payload.storeId ||
      Number(payment.amount_cents) !== payload.amount.amount ||
      payment.currency !== payload.amount.currency ||
      payment.payment_method !== method ||
      (transactionReference !== null &&
        transactionReference !== payment.reference) ||
      (payment.jeko_payment_id &&
        payment.jeko_payment_id !== paymentRequestId)
    ) {
      throw serviceError(
        "Les informations de la transaction Jèko ne correspondent pas.",
        400
      );
    }

    const existingTransaction = await client.query(
      `SELECT id
       FROM jeko_payments
       WHERE jeko_transaction_id = $1
       FOR UPDATE`,
      [transactionId]
    );

    if (
      existingTransaction.rows.length &&
      String(existingTransaction.rows[0].id) !== String(payment.id)
    ) {
      throw serviceError(
        "Cette transaction est déjà associée à une autre demande.",
        409
      );
    }

    if (payment.status === "paid") {
      if (payment.jeko_transaction_id === transactionId) {
        await client.query("COMMIT");
        transactionStarted = false;
        return { ok: true, duplicate: true };
      }

      throw serviceError(
        "Cette demande a déjà été réglée avec une autre transaction.",
        409
      );
    }

    if (payment.status !== "pending") {
      throw serviceError("Cette demande n'est plus en attente.", 409);
    }

    const eventHash = crypto
      .createHash("sha256")
      .update(rawBody)
      .digest("hex");

    const eventInsert = await client.query(
      `INSERT INTO jeko_webhook_events (
         event_key, payment_id, event_type, payload_sha256
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING event_key`,
      [transactionId, payment.id, eventName, eventHash]
    );

    if (eventInsert.rowCount !== 1) {
      const existingEvent = await client.query(
        `SELECT payment_id
         FROM jeko_webhook_events
         WHERE event_key = $1
         FOR UPDATE`,
        [transactionId]
      );

      if (
        !existingEvent.rows.length ||
        String(existingEvent.rows[0].payment_id) !== String(payment.id)
      ) {
        throw serviceError(
          "Cette transaction a déjà été enregistrée pour une autre demande.",
          409
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return { ok: true, duplicate: true };
    }

    const userResult = await client.query(
      `SELECT premium_until
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [payment.user_id]
    );

    const user = userResult.rows[0];

    if (!user) {
      throw serviceError("Utilisateur BATBOT PRO introuvable.", 404);
    }

    const selectedOffer = PREMIUM_OFFERS[payment.offer];

    if (!selectedOffer) {
      throw serviceError("Formule Premium inconnue.");
    }

    const now = new Date();
    const previousUntil = user.premium_until
      ? new Date(user.premium_until)
      : null;

    if (previousUntil && Number.isNaN(previousUntil.getTime())) {
      throw serviceError("Date d'expiration Premium invalide.", 500);
    }

    const currentUntil =
      previousUntil && previousUntil > now ? previousUntil : now;

    const premiumUntil = new Date(
      currentUntil.getTime() +
      selectedOffer.days * 24 * 60 * 60 * 1000
    );

    const userUpdate = await client.query(
      `UPDATE users
       SET premium_started_at = $1,
           premium_until = $2
       WHERE id = $3`,
      [now.toISOString(), premiumUntil.toISOString(), payment.user_id]
    );

    if (userUpdate.rowCount !== 1) {
      throw serviceError(
        "Impossible de mettre à jour l'abonnement Premium.",
        500
      );
    }

    const paymentUpdate = await client.query(
      `UPDATE jeko_payments
       SET status = 'paid',
           jeko_payment_id = COALESCE(jeko_payment_id, $2),
           jeko_transaction_id = $3,
           provider_status = $4,
           paid_at = $5,
           updated_at = $5
       WHERE id = $1 AND status = 'pending'`,
      [
        payment.id,
        paymentRequestId,
        transactionId,
        payload.status,
        now.toISOString()
      ]
    );

    if (paymentUpdate.rowCount !== 1) {
      throw serviceError(
        "La confirmation du paiement n'a pas pu être enregistrée.",
        500
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      ok: true,
      activated: true,
      paymentId: payment.id
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  initializeJekoPayments,
  createJekoPayment,
  checkJekoPaymentStatus,
  verifyJekoSignature,
  handleJekoWebhook
};

"use strict";

const defaultSecurity = require("./telegram-admin-security");
const defaultConsole = require("./telegram-admin-console");

function createTelegramAdminHandler({
  pool,
  resolvePaymentRequest,
  security = defaultSecurity,
  consoleModule = defaultConsole,
  fetchImpl = globalThis.fetch,
  env = process.env,
  logger = console
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("Telegram handler: pool PostgreSQL invalide.");
  }

  if (typeof resolvePaymentRequest !== "function") {
    throw new Error("Telegram handler: resolvePaymentRequest obligatoire.");
  }

  if (!fetchImpl || typeof fetchImpl !== "function") {
    throw new Error("Telegram handler: fetch indisponible.");
  }

  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.TELEGRAM_ADMIN_CHAT_ID || "").trim();

  async function telegram(method, payload) {
    if (!token || !chatId) {
      throw new Error("Configuration Telegram incomplète.");
    }

    const response = await fetchImpl(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!response.ok) {
      throw new Error(`Telegram HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.ok) {
      throw new Error("Telegram a refusé la requête.");
    }

    return result.result;
  }

  async function sendMessage(text, replyMarkup) {
    const payload = { chat_id: chatId, text };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    return telegram("sendMessage", payload);
  }

  async function answerCallback(callbackId, text) {
    try {
      await telegram("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: text || "Traitement en cours."
      });
    } catch (error) {
      logger.error("BATBOT TELEGRAM CALLBACK:", error.message);
    }
  }

  async function editCallbackMessage(callback, text, replyMarkup) {
    const message = callback.message;

    if (!message || !message.message_id) {
      return sendMessage(text, replyMarkup);
    }

    const payload = {
      chat_id: chatId,
      message_id: message.message_id,
      text
    };

    payload.reply_markup = replyMarkup || {
      inline_keyboard: []
    };

    try {
      return await telegram("editMessageText", payload);
    } catch (error) {
      logger.error("BATBOT TELEGRAM EDIT:", error.message);
      return sendMessage(text, replyMarkup);
    }
  }

  async function getPendingPayment(paymentId) {
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.offer, p.operator, p.amount,
              p.created_at, p.status, u.username, u.phone
       FROM payment_requests p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND p.status = 'pending'
       LIMIT 1`,
      [paymentId]
    );

    return result.rows[0] || null;
  }

  async function showPendingPayments() {
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.offer, p.operator, p.amount,
              p.created_at, p.status, u.username, u.phone
       FROM payment_requests p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.status = 'pending'
       ORDER BY p.id ASC
       LIMIT 10`
    );

    if (!result.rows.length) {
      await sendMessage("✅ Aucune demande de paiement en attente.");
      return;
    }

    await sendMessage(
      `📋 DEMANDES PREMIUM EN ATTENTE\n${result.rows.length} demande(s) affichée(s), maximum 10.`
    );

    for (const payment of result.rows) {
      await sendMessage(
        consoleModule.formatPaymentDetails(payment),
        consoleModule.buildPaymentKeyboard(payment.id)
      );
    }
  }

  async function handleCommand(message) {
    const text = String(message.text || "").trim();
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

    if (command === "/start" || command === "/help") {
      await sendMessage([
        "🤖 BATBOT PRO — CONSOLE ADMINISTRATEUR",
        "",
        "Commandes disponibles :",
        "/paiements — Voir les demandes Premium en attente",
        "/help — Afficher cette aide",
        "",
        "Tu peux gérer les demandes directement avec les boutons."
      ].join("\n"));
      return true;
    }

    if (command === "/paiements") {
      await showPendingPayments();
      return true;
    }

    return false;
  }

  async function finishResolution(callback, result, status, note = "") {
    if (!result.ok) {
      await editCallbackMessage(
        callback,
        `⚠️ DEMANDE #${callback.dataPaymentId}\n${result.error || "Traitement impossible."}`
      );
      return;
    }

    const request = result.request || {};
    const paymentId = request.id || callback.dataPaymentId;

    const lines = [
      status === "accepted"
        ? "✅ PAIEMENT ACCEPTÉ — BATBOT PRO"
        : "❌ PAIEMENT REFUSÉ — BATBOT PRO",
      "",
      `Demande : #${paymentId}`,
      `Membre : ${request.user_id || "Non renseigné"}`,
      `Offre : ${request.offer || "Non renseignée"}`,
      `Montant : ${request.amount || "?"} FCFA`
    ];

    if (status === "rejected") {
      lines.push("", `Motif : ${note}`);
    } else {
      lines.push("", "Le traitement Premium a été effectué.");
    }

    await editCallbackMessage(callback, lines.join("\n"));
  }

  async function handleCallback(callback) {
    const parsed = consoleModule.parsePaymentCallback(callback.data);

    if (!parsed) {
      await answerCallback(callback.id, "Action invalide.");
      return;
    }

    callback.dataPaymentId = parsed.paymentId;

    // Répondre immédiatement à Telegram avant toute opération SQL.
    await answerCallback(callback.id, "Traitement en cours.");

    if (parsed.action === "choose_rejection") {
      const payment = await getPendingPayment(parsed.paymentId);

      if (!payment) {
        await editCallbackMessage(
          callback,
          `⚠️ La demande #${parsed.paymentId} n'est plus en attente.`
        );
        return;
      }

      await editCallbackMessage(
        callback,
        `❌ CHOISIR LE MOTIF DU REFUS — DEMANDE #${parsed.paymentId}`,
        consoleModule.buildRejectionKeyboard(parsed.paymentId)
      );
      return;
    }

    if (parsed.action === "reject_other") {
      const payment = await getPendingPayment(parsed.paymentId);

      if (!payment) {
        await editCallbackMessage(
          callback,
          `⚠️ La demande #${parsed.paymentId} n'est plus en attente.`
        );
        return;
      }

      const prompt = consoleModule.buildOtherReasonPrompt(parsed.paymentId);
      await sendMessage(prompt.text, prompt.reply_markup);
      return;
    }

    const rejectionReasons = {
      reject_funds: "Fonds non reçus.",
      reject_amount: "Montant reçu incorrect."
    };

    let status;
    let note = "";

    if (parsed.action === "accept") {
      status = "accepted";
    } else if (Object.prototype.hasOwnProperty.call(
      rejectionReasons,
      parsed.action
    )) {
      status = "rejected";
      note = rejectionReasons[parsed.action];
    } else {
      await editCallbackMessage(callback, "⚠️ Action inconnue.");
      return;
    }

    const result = await resolvePaymentRequest(
      parsed.paymentId,
      status,
      note
    );

    await finishResolution(callback, result, status, note);
  }

  async function handleOtherReason(message) {
    const repliedMessage = message.reply_to_message;
    const promptText = String(repliedMessage?.text || "");
    const match = promptText.match(
      /^✍️ AUTRE MOTIF — DEMANDE #([1-9]\d*)(?:\r?\n|$)/
    );

    if (
      !repliedMessage ||
      repliedMessage.from?.is_bot !== true ||
      !message.chat ||
      message.chat.type !== "private" ||
      String(message.chat.id) !== "6035184399" ||
      !repliedMessage.chat ||
      String(repliedMessage.chat.id) !== String(message.chat.id) ||
      !Number.isSafeInteger(repliedMessage.message_id) ||
      repliedMessage.message_id <= 0 ||
      !match
    ) {
      return false;
    }

    const paymentId = Number(match[1]);

    if (!consoleModule.validPaymentId(paymentId)) {
      await sendMessage("⚠️ Identifiant de demande invalide.");
      return true;
    }

    const note = consoleModule.normalizeRejectionReason(message.text);

    if (!note) {
      await sendMessage("⚠️ Le motif de refus est obligatoire. Réponds à nouveau au message de demande de motif.");
      return true;
    }

    const payment = await getPendingPayment(paymentId);

    if (!payment) {
      await sendMessage(
        `⚠️ La demande #${paymentId} n'est plus en attente.`
      );
      return true;
    }

    const result = await resolvePaymentRequest(
      paymentId,
      "rejected",
      note
    );

    if (!result.ok) {
      await sendMessage(
        `⚠️ Impossible de traiter la demande #${paymentId}.\n${result.error}`
      );
      return true;
    }

    await sendMessage([
      "❌ PAIEMENT REFUSÉ — BATBOT PRO",
      "",
      `Demande : #${paymentId}`,
      `Membre : ${result.request?.user_id || payment.user_id}`,
      `Offre : ${result.request?.offer || payment.offer}`,
      `Motif : ${note}`
    ].join("\n"));

    return true;
  }

  async function handleUpdate(update) {
    if (!security.isAuthorizedTelegramUpdate(update)) {
      return { ok: false, statusCode: 403 };
    }

    if (!token || !chatId || chatId !== "6035184399") {
      logger.error("BATBOT TELEGRAM: configuration administrateur invalide.");
      return { ok: false, statusCode: 503 };
    }

    try {
      if (update.callback_query) {
        await handleCallback(update.callback_query);
        return { ok: true };
      }

      const message = update.message;

      if (!message || typeof message.text !== "string") {
        return { ok: true, ignored: true };
      }

      if (await handleOtherReason(message)) {
        return { ok: true };
      }

      if (await handleCommand(message)) {
        return { ok: true };
      }

      await sendMessage(
        "Commande non reconnue. Utilise /paiements pour consulter les demandes ou /help pour afficher l'aide."
      );

      return { ok: true };
    } catch (error) {
      logger.error("BATBOT TELEGRAM ADMIN HANDLER:", error.message);

      try {
        await sendMessage(
          "⚠️ Une erreur est survenue pendant le traitement. Vérifie le tableau de bord administrateur."
        );
      } catch (sendError) {
        logger.error("BATBOT TELEGRAM ERROR MESSAGE:", sendError.message);
      }

      return { ok: false, statusCode: 500 };
    }
  }

  return { handleUpdate };
}

module.exports = { createTelegramAdminHandler };

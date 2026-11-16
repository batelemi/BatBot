"use strict";

function cleanTelegramText(value, maxLength = 150) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validPaymentId(value) {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
  ) {
    return null;
  }

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function formatPaymentDetails(payment) {
  const id = validPaymentId(payment?.id);
  const userId = validPaymentId(payment?.user_id);

  if (!id || !userId) {
    throw new Error("Identifiant de paiement ou de membre invalide.");
  }

  const username = cleanTelegramText(payment.username || "Non renseigné");
  const phone = cleanTelegramText(payment.phone || "Non renseigné");
  const offer = cleanTelegramText(payment.offer || "Non renseignée");
  const operator = cleanTelegramText(payment.operator || "Non renseigné");
  const amount = Number(payment.amount);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Montant de paiement invalide.");
  }

  const createdAt = payment.created_at
    ? new Date(payment.created_at)
    : null;

  const date = createdAt && !Number.isNaN(createdAt.getTime())
    ? createdAt.toLocaleString("fr-FR", { timeZone: "UTC" })
    : "Non renseignée";

  return [
    "🔔 DEMANDE PREMIUM — BATBOT PRO",
    "",
    `Demande : #${id}`,
    `Membre : #${userId}`,
    `Nom d'utilisateur : ${username}`,
    `Téléphone : ${phone}`,
    `Offre : ${offer}`,
    `Montant : ${amount} FCFA`,
    `Opérateur : ${operator}`,
    `Date : ${date}`,
    "Statut : EN ATTENTE",
    "",
    "Choisissez une action :"
  ].join("\n");
}

function buildPaymentKeyboard(paymentId) {
  const id = validPaymentId(paymentId);

  if (!id) {
    throw new Error("Identifiant de paiement invalide.");
  }

  return {
    inline_keyboard: [
      [
        { text: "✅ Accepter", callback_data: `bp:a:${id}` },
        { text: "❌ Refuser", callback_data: `bp:r:${id}` }
      ]
    ]
  };
}

function buildRejectionKeyboard(paymentId) {
  const id = validPaymentId(paymentId);

  if (!id) {
    throw new Error("Identifiant de paiement invalide.");
  }

  return {
    inline_keyboard: [
      [{ text: "Fonds non reçus", callback_data: `bp:rf:${id}` }],
      [{ text: "Montant incorrect", callback_data: `bp:ra:${id}` }],
      [{ text: "Autre motif", callback_data: `bp:ro:${id}` }]
    ]
  };
}

function parsePaymentCallback(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 64
  ) {
    return null;
  }

  const match = /^bp:(a|r|rf|ra|ro):([1-9]\d*)$/.exec(value);

  if (!match) {
    return null;
  }

  const id = validPaymentId(match[2]);

  if (!id) {
    return null;
  }

  const actions = {
    a: "accept",
    r: "choose_rejection",
    rf: "reject_funds",
    ra: "reject_amount",
    ro: "reject_other"
  };

  return {
    action: actions[match[1]],
    paymentId: id
  };
}

function buildOtherReasonPrompt(paymentId) {
  const id = validPaymentId(paymentId);

  if (!id) {
    throw new Error("Identifiant de paiement invalide.");
  }

  return {
    text: [
      `✍️ AUTRE MOTIF — DEMANDE #${id}`,
      "",
      "Répondez à ce message avec le motif du refus.",
      "Le motif est obligatoire et limité à 1 000 caractères."
    ].join("\n"),
    reply_markup: {
      force_reply: true,
      selective: true
    }
  };
}

function normalizeRejectionReason(value) {
  return String(value ?? "").trim().slice(0, 1000);
}

module.exports = {
  cleanTelegramText,
  validPaymentId,
  formatPaymentDetails,
  buildPaymentKeyboard,
  buildRejectionKeyboard,
  parsePaymentCallback,
  buildOtherReasonPrompt,
  normalizeRejectionReason
};

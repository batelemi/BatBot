"use strict";

const crypto = require("crypto");

function getTelegramAdminId(env = process.env) {
  const value = String(env.TELEGRAM_ADMIN_CHAT_ID || "").trim();

  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function isValidTelegramWebhookSecret(receivedSecret) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (
    typeof expectedSecret !== "string" ||
    expectedSecret.length === 0 ||
    expectedSecret.length > 256 ||
    typeof receivedSecret !== "string" ||
    receivedSecret.length === 0
  ) {
    return false;
  }

  const expected = Buffer.from(expectedSecret, "utf8");
  const received = Buffer.from(receivedSecret, "utf8");

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

function isAuthorizedTelegramUpdate(update, env = process.env) {
  const adminId = getTelegramAdminId(env);

  if (!adminId || !update || typeof update !== "object") {
    return false;
  }

  let sender;
  let chat;

  if (update.message) {
    sender = update.message.from;
    chat = update.message.chat;
  } else if (update.callback_query) {
    sender = update.callback_query.from;
    chat = update.callback_query.message?.chat;
  } else {
    return false;
  }

  return Boolean(
    sender &&
    chat &&
    Number.isSafeInteger(sender.id) &&
    Number.isSafeInteger(chat.id) &&
    sender.id === adminId &&
    chat.id === adminId &&
    chat.type === "private"
  );
}

module.exports = {
  getTelegramAdminId,
  isValidTelegramWebhookSecret,
  isAuthorizedTelegramUpdate
};

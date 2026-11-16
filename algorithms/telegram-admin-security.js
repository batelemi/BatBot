"use strict";

const crypto = require("crypto");

const TELEGRAM_ADMIN_ID = 6035184399;

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

function isAuthorizedTelegramUpdate(update) {
  if (!update || typeof update !== "object") {
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
    sender.id === TELEGRAM_ADMIN_ID &&
    chat.id === TELEGRAM_ADMIN_ID &&
    chat.type === "private"
  );
}

module.exports = {
  isValidTelegramWebhookSecret,
  isAuthorizedTelegramUpdate
};

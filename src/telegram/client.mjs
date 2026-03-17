// Telegram MTProto connection management

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { existsSync, readFileSync } from "fs";
import {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_SESSION,
  SESSION_FILE,
} from "../config.mjs";

let telegramClient;

export async function connectTelegram(retries = 3) {
  let sessionString = TELEGRAM_SESSION;
  if (!sessionString && existsSync(SESSION_FILE)) {
    sessionString = readFileSync(SESSION_FILE, "utf8").trim();
  }

  if (!sessionString) {
    console.error("No Telegram session found!");
    console.error("Run auth-session.mjs first to create a session.");
    process.exit(1);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Disconnect previous client if retrying
      if (telegramClient) {
        try { await telegramClient.disconnect(); } catch {}
        telegramClient = null;
      }

      telegramClient = new TelegramClient(
        new StringSession(sessionString),
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH,
        { connectionRetries: 5 }
      );

      await telegramClient.connect();
      console.log("Connected to Telegram");
      return telegramClient;
    } catch (err) {
      // AUTH_KEY_DUPLICATED means the session is invalid/stale — retrying won't help
      const isRetryable =
        err.code === 420 || // FLOOD_WAIT
        err.message?.includes("TIMEOUT") ||
        err.message?.includes("ECONNRESET");

      if (isRetryable && attempt < retries) {
        const delay = attempt * 5000;
        console.warn(
          `Telegram connect failed (${err.errorMessage || err.message}), retrying in ${delay / 1000}s (attempt ${attempt}/${retries})...`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

export async function joinChannel(channelUsername) {
  try {
    const entity = await telegramClient.getEntity(channelUsername);
    try {
      await telegramClient.getParticipant(entity, await telegramClient.getMe());
    } catch {
      await telegramClient.invoke(
        new telegramClient.constructor.Api.channels.JoinChannel({ channel: entity })
      );
      console.log(`  Joined @${channelUsername}`);
    }
  } catch (err) {
    console.warn(`  Could not join @${channelUsername}: ${err.message}`);
  }
}

export function getClient() {
  return telegramClient;
}

import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import os from "os";

// ── Demos Blockchain ─────────────────────────────────────────
export const RPC_URL = process.env.DEMOS_RPC_URL || "https://demosnode.discus.sh/";
export const MNEMONIC = process.env.DEMOS_MNEMONIC;
export const COLONY_URL = process.env.COLONY_URL || "https://www.supercolony.ai";

// ── Telegram MTProto ─────────────────────────────────────────
export const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
export const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || "";
export const SESSION_FILE = ".telegram-session.txt";

// ── DeepSeek AI ──────────────────────────────────────────────
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ── OpenAI Embeddings ────────────────────────────────────────
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ── LanceDB ──────────────────────────────────────────────────
export const LANCEDB_PATH = process.env.LANCEDB_PATH || "./data/lancedb";

// ── Modes ────────────────────────────────────────────────────
export const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";

// ── Channel Configuration ────────────────────────────────────
const CHANNELS_FILE = "channels.json";

function loadChannels() {
  // Env override: comma-separated channel usernames
  if (process.env.TELEGRAM_CHANNELS) {
    return process.env.TELEGRAM_CHANNELS.split(",").map((ch) => ({
      username: ch.trim(),
      topic: "general",
      tags: ["telegram"],
      pollIntervalMs: 60000,
    }));
  }

  // channels.json
  if (existsSync(CHANNELS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(CHANNELS_FILE, "utf8"));
      return raw.channels || [];
    } catch (err) {
      console.error(`Failed to parse ${CHANNELS_FILE}: ${err.message}`);
      process.exit(1);
    }
  }

  // Fallback: single channel from .env
  const single = process.env.TELEGRAM_CHANNEL;
  if (!single) {
    console.error("Error: TELEGRAM_CHANNEL or channels.json required");
    process.exit(1);
  }
  return [
    {
      username: single,
      topic: "geopolitics",
      tags: ["geopolitics", "telegram"],
      pollIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || "60000", 10),
    },
  ];
}

export const channels = loadChannels();

// ── External Sources (RSS + HTTP APIs) ───────────────────────
const SOURCES_FILE = "sources.json";

function loadSources() {
  if (existsSync(SOURCES_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(SOURCES_FILE, "utf8"));
      return (raw.sources || []).filter((s) => s.enabled !== false);
    } catch (err) {
      console.warn(`Failed to parse ${SOURCES_FILE}: ${err.message}`);
    }
  }
  return [];
}

export const externalSources = loadSources();

// ── Alert Push Notifications ─────────────────────────────────
export const ALERT_BOT_TOKEN = process.env.ALERT_BOT_TOKEN;
export const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;

// ── Agent Identity (for agent mesh registration) ─────────────
export const AGENT_ID = process.env.AGENT_ID || `geoscope-${os.hostname()}`;
export const AGENT_NAME = process.env.AGENT_NAME || "Geoscope";
export const COCKPIT_URL = process.env.COCKPIT_URL || "http://localhost:3002";

// ── Validation ───────────────────────────────────────────────
export function validateConfig() {
  const errors = [];
  if (!MNEMONIC) errors.push("DEMOS_MNEMONIC is required in .env");
  if (!TELEGRAM_API_ID || isNaN(TELEGRAM_API_ID) || !TELEGRAM_API_HASH)
    errors.push("TELEGRAM_API_ID (numeric) and TELEGRAM_API_HASH are required");
  if (!DEEPSEEK_API_KEY) errors.push("DEEPSEEK_API_KEY is required in .env");
  if (channels.length === 0) errors.push("No channels configured");

  if (errors.length > 0) {
    for (const e of errors) console.error(`Error: ${e}`);
    process.exit(1);
  }
}

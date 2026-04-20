// Alert Notifier — push ALERT-category posts via Telegram Bot
//
// Config (env vars):
//   ALERT_BOT_TOKEN  — Telegram bot token (from @BotFather)
//   ALERT_CHAT_ID    — Chat/channel ID to send alerts to (group, channel, or user chat)
//
// If neither is set, notifier silently does nothing (non-blocking).

const BOT_TOKEN = process.env.ALERT_BOT_TOKEN;
const CHAT_ID = process.env.ALERT_CHAT_ID;

const TELEGRAM_API = "https://api.telegram.org";

// Rate limit: max 1 alert per 10 seconds to avoid Telegram flood limits
let lastSent = 0;
const MIN_INTERVAL_MS = 10000;

export function alertsEnabled() {
  return !!(BOT_TOKEN && CHAT_ID);
}

/**
 * Send an ALERT notification to the configured Telegram chat.
 *
 * @param {object} alert
 *   @param {string} alert.category  - "ALERT" | "ANALYSIS" | ...
 *   @param {string} alert.text      - Analysis text
 *   @param {string} alert.channel   - Source channel/name
 *   @param {string} alert.topic     - Topic tag
 *   @param {number} alert.confidence - 0-100
 *   @param {string|null} alert.txUrl - On-chain tx URL (optional)
 *   @param {string|null} alert.storyId - Story cluster ID (optional)
 */
export async function sendAlert(alert) {
  if (!alertsEnabled()) return;

  const now = Date.now();
  if (now - lastSent < MIN_INTERVAL_MS) return; // simple rate limiting
  lastSent = now;

  const { text, channel, topic, confidence, txUrl } = alert;

  const confidenceBar = confidence >= 80 ? "🔴" : confidence >= 60 ? "🟠" : "🟡";
  const sourceLabel = channel ? `@${channel}` : "unknown";

  const message = [
    `${confidenceBar} *ALERT* — ${topic.toUpperCase()}`,
    ``,
    text.slice(0, 600),
    ``,
    `Source: ${sourceLabel} | Confidence: ${confidence}%`,
    txUrl ? `[On-chain proof](${txUrl})` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");

  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[Alert] Telegram send failed: ${res.status} — ${body.slice(0, 200)}`);
    } else {
      console.log(`[Alert] Sent ALERT notification for ${sourceLabel}`);
    }
  } catch (err) {
    console.warn(`[Alert] Telegram send error: ${err.message}`);
  }
}

/**
 * Send a daily digest summary message.
 *
 * @param {object} digest
 *   @param {number} digest.totalPublished
 *   @param {number} digest.alertCount
 *   @param {number} digest.analysisCount
 *   @param {string[]} digest.topChannels
 *   @param {Array<{title:string,channels:string[],postCount:number}>} digest.topStories
 */
export async function sendDailyDigest(digest) {
  if (!alertsEnabled()) return;

  const { totalPublished, alertCount, analysisCount, topChannels = [], topStories = [] } = digest;

  const storiesSection = topStories.length > 0
    ? `\n📰 *Top Stories*\n` + topStories.slice(0, 5).map(
        (s) => `• ${s.title.slice(0, 80)} (${s.postCount} sources)`
      ).join("\n")
    : "";

  const channelsSection = topChannels.length > 0
    ? `\n📡 *Most Active*: ${topChannels.slice(0, 5).join(", ")}`
    : "";

  const message = [
    `🌐 *Geoscope Daily Brief*`,
    ``,
    `Published: ${totalPublished} | Alerts: ${alertCount} | Analyses: ${analysisCount}`,
    storiesSection,
    channelsSection,
  ].join("\n");

  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[Alert] Daily digest send failed: ${res.status} — ${body.slice(0, 200)}`);
    } else {
      console.log("[Alert] Daily digest sent");
    }
  } catch (err) {
    console.warn(`[Alert] Daily digest error: ${err.message}`);
  }
}

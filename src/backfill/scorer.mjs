// Local relevance scoring for backfill messages — zero API calls

const HIGH_SIGNAL_KEYWORDS = [
  "strike", "missile", "nato", "sanction", "breaking", "invasion",
  "ceasefire", "nuclear", "deployment", "offensive", "casualt",
  "escalat", "airstr", "drone", "artillery", "frontline", "surrender",
  "blockade", "mobiliz", "annex", "coup", "martial law",
];

const MEDIUM_SIGNAL_KEYWORDS = [
  "election", "oil", "trade", "protest", "summit", "negotiat",
  "diplomat", "refugee", "inflation", "embargo", "tariff",
  "alliance", "intelligence", "military", "border", "tension",
];

const PROMO_PATTERNS = [
  /join\s+(our\s+)?channel/i,
  /subscribe/i,
  /boost\s+(this|our)/i,
  /t\.me\/\w+\s*$/i,
  /follow\s+us/i,
  /share\s+this/i,
  /check\s+out\s+our/i,
  /sponsored/i,
  /advertis/i,
];

const BREAKING_CHANNELS = [];

const URL_RE = /https?:\/\/[^\s)]+/g;

export function scoreMessage(text, message, channel) {
  let score = 0;
  const reasons = [];
  const lower = (text || "").toLowerCase();

  // 1. Text length (max 15)
  const len = text ? text.length : 0;
  if (len > 500) {
    score += 15;
    reasons.push("long text (>500)");
  } else if (len > 200) {
    score += 10;
    reasons.push("medium text (>200)");
  } else if (len > 80) {
    score += 5;
    reasons.push("short text (>80)");
  }

  // 2. URL presence (max 15)
  const urls = text ? text.match(URL_RE) : null;
  const urlCount = urls ? urls.length : 0;
  if (urlCount >= 2) {
    score += 15;
    reasons.push(`${urlCount} URLs`);
  } else if (urlCount === 1) {
    score += 10;
    reasons.push("1 URL");
  }

  // 3. High-signal keywords (max 30, 5pts each)
  let highPts = 0;
  for (const kw of HIGH_SIGNAL_KEYWORDS) {
    if (lower.includes(kw)) {
      highPts += 5;
      if (highPts >= 30) break;
    }
  }
  if (highPts > 0) {
    score += highPts;
    reasons.push(`high-signal keywords (+${highPts})`);
  }

  // 4. Medium-signal keywords (max 15, 3pts each)
  let medPts = 0;
  for (const kw of MEDIUM_SIGNAL_KEYWORDS) {
    if (lower.includes(kw)) {
      medPts += 3;
      if (medPts >= 15) break;
    }
  }
  if (medPts > 0) {
    score += medPts;
    reasons.push(`medium-signal keywords (+${medPts})`);
  }

  // 5. Freshness (max 15) — message.date is Unix seconds
  const msgTime = message?.date ? message.date * 1000 : 0;
  if (msgTime > 0) {
    const ageDays = (Date.now() - msgTime) / (1000 * 60 * 60 * 24);
    if (ageDays <= 7) {
      score += 15;
      reasons.push("fresh (≤7d)");
    } else if (ageDays <= 30) {
      score += 10;
      reasons.push("recent (≤30d)");
    } else if (ageDays <= 90) {
      score += 5;
      reasons.push("moderate age (≤90d)");
    }
  }

  // 6. Media (max 5)
  if (message?.media) {
    score += 5;
    reasons.push("has media");
  }

  // 7. Channel weight (max 5)
  const username = typeof channel === "string" ? channel : channel?.username;
  if (username && BREAKING_CHANNELS.includes(username)) {
    score += 5;
    reasons.push("breaking-news channel");
  }

  // 8. Promo penalty (-15)
  for (const pattern of PROMO_PATTERNS) {
    if (pattern.test(text || "")) {
      score -= 15;
      reasons.push("promo penalty (-15)");
      break;
    }
  }

  // Clamp 0–100
  score = Math.max(0, Math.min(100, score));

  // Tier assignment
  let tier;
  if (score >= 60) tier = "full";
  else if (score >= 30) tier = "embed";
  else tier = "skip";

  return { score, reasons, tier };
}

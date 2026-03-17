// URL extraction and classification from Telegram messages

const PROMO_KEYWORDS = /\b(join|boost|subscribe|chat|contact|support|channel|group)\b/i;

export function extractUrls(message) {
  const urls = new Set();
  const text = message.message || "";

  // Extract from plain text
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  for (const match of text.matchAll(urlRegex)) {
    // Strip trailing punctuation that's likely sentence-ending, not part of the URL
    const cleaned = match[1].replace(/[.,!?;:)}\]>]+$/, "");
    urls.add(cleaned);
  }

  // Extract from Telegram message entities (hidden hyperlinks, text URLs)
  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.className === "MessageEntityTextUrl" && entity.url) {
        urls.add(entity.url);
      } else if (entity.className === "MessageEntityUrl") {
        const entityUrl = text.slice(entity.offset, entity.offset + entity.length);
        if (/^https?:\/\//i.test(entityUrl)) {
          urls.add(entityUrl);
        }
      }
    }
  }

  return [...urls];
}

export function classifyUrls(urls, text, channelUsername) {
  const sourceUrls = [];
  const promoUrls = [];

  for (const url of urls) {
    const lower = url.toLowerCase();

    // t.me invite links (t.me/+xxx)
    if (/t\.me\/\+/.test(lower)) {
      promoUrls.push(url);
      continue;
    }

    // t.me channel links
    if (/t\.me\//.test(lower)) {
      const tmeMatch = lower.match(/t\.me\/([a-z0-9_]+)/i);
      if (tmeMatch) {
        const handle = tmeMatch[1].toLowerCase();
        // Self-link to the source channel
        if (channelUsername && handle === channelUsername.toLowerCase()) {
          promoUrls.push(url);
          continue;
        }
        // Bare t.me/username with no post ID → likely promo
        if (!/t\.me\/[a-z0-9_]+\/\d+/i.test(lower)) {
          promoUrls.push(url);
          continue;
        }
      }
    }

    // Bare social profile URLs (no article/status path)
    if (/^https?:\/\/(www\.)?(twitter|x)\.com\/[a-z0-9_]+\/?$/i.test(lower)) {
      promoUrls.push(url);
      continue;
    }

    // Check surrounding text for promotional keywords
    const urlIndex = text.indexOf(url);
    if (urlIndex !== -1) {
      const surroundingStart = Math.max(0, urlIndex - 80);
      const surroundingEnd = Math.min(text.length, urlIndex + url.length + 80);
      const surrounding = text.slice(surroundingStart, surroundingEnd);
      if (PROMO_KEYWORDS.test(surrounding) && !/t\.me\/[a-z0-9_]+\/\d+/i.test(lower)) {
        promoUrls.push(url);
        continue;
      }
    }

    sourceUrls.push(url);
  }

  return { sourceUrls, promoUrls };
}

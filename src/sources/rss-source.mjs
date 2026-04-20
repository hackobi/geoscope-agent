// RSS/Atom feed source adapter
// Polls a feed URL, parses items, tracks seen guids in data/rss-state.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const STATE_FILE = "data/rss-state.json";

function ensureDataDir() {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
}

// ── Minimal XML parser for RSS/Atom ──────────────────────────

function extractTag(xml, tag) {
  // Handle self-closing <tag/> and tags with attributes
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["'][^>]*>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

function decodeCdata(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseItems(xml) {
  const items = [];

  // RSS: <item> blocks
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = stripHtml(decodeCdata(extractTag(block, "title") || ""));
    const link =
      extractTag(block, "link") ||
      extractAttr(block, "link", "href") ||
      "";
    const guid = extractTag(block, "guid") || link;
    const description = stripHtml(decodeCdata(extractTag(block, "description") || extractTag(block, "content:encoded") || ""));
    const pubDateStr = extractTag(block, "pubDate") || extractTag(block, "dc:date") || "";
    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();

    if (!title && !description) continue;
    items.push({
      id: guid || title,
      title,
      link: link.trim(),
      text: [title, description].filter(Boolean).join("\n\n").slice(0, 2000),
      date: isNaN(pubDate.getTime()) ? new Date() : pubDate,
    });
  }

  // Atom: <entry> blocks (if no RSS items found)
  if (items.length === 0) {
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1];
      const title = stripHtml(decodeCdata(extractTag(block, "title") || ""));
      const link = extractAttr(block, "link", "href") || extractTag(block, "link") || "";
      const id = extractTag(block, "id") || link;
      const summary = stripHtml(decodeCdata(extractTag(block, "summary") || extractTag(block, "content") || ""));
      const publishedStr = extractTag(block, "published") || extractTag(block, "updated") || "";
      const pubDate = publishedStr ? new Date(publishedStr) : new Date();

      if (!title && !summary) continue;
      items.push({
        id: id || title,
        title,
        link: link.trim(),
        text: [title, summary].filter(Boolean).join("\n\n").slice(0, 2000),
        date: isNaN(pubDate.getTime()) ? new Date() : pubDate,
      });
    }
  }

  return items;
}

// ── State management ──────────────────────────────────────────

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveState(state) {
  try {
    ensureDataDir();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[RSS] Failed to save state:", err.message);
  }
}

// ── Main poller class ─────────────────────────────────────────

export class RssSource {
  constructor(sourceConfig, onMessages) {
    this.config = sourceConfig;   // { name, url, topic, tags, pollIntervalMs, credibility, type: "rss" }
    this.onMessages = onMessages;
    this.state = loadState();
    this.running = false;
    this.timer = null;
  }

  async poll() {
    const { name, url } = this.config;
    const seenIds = new Set(this.state[name] || []);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Geoscope/1.0 (+https://github.com/geoscope)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.warn(`[RSS:${name}] Fetch failed: ${res.status}`);
        return;
      }
      const xml = await res.text();
      const items = parseItems(xml);

      const newItems = items.filter((item) => !seenIds.has(item.id));
      if (newItems.length === 0) return;

      console.log(`[RSS:${name}] ${newItems.length} new item(s)`);

      // Translate to Telegram-compatible message format
      const messages = newItems.map((item) => ({
        id: Math.abs(hashCode(item.id)),
        message: item.text,
        date: Math.floor(item.date.getTime() / 1000),
        media: null,
        fwdFrom: null,
        _rssMeta: { title: item.title, link: item.link },
      }));

      // Mark as seen
      const updatedIds = [...seenIds, ...newItems.map((i) => i.id)];
      this.state[name] = updatedIds.slice(-500); // cap history
      saveState(this.state);

      await this.onMessages(this.config, messages);
    } catch (err) {
      console.warn(`[RSS:${name}] Poll error: ${err.message}`);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Stagger first poll by 10s to avoid startup thundering herd
    setTimeout(async () => {
      if (!this.running) return;
      await this.poll();
      this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    }, 10000);
    console.log(`[RSS:${this.config.name}] Poller started (every ${this.config.pollIntervalMs / 1000}s)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// djb2 hash for stable numeric IDs
function hashCode(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash;
}

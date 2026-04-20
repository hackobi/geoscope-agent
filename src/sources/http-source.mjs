// Generic HTTP/JSON API source adapter
// Polls a JSON endpoint, extracts items by configurable field paths
// Usage: REST APIs like Reddit JSON, HN Algolia, custom feeds

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const STATE_FILE = "data/http-state.json";

function ensureDataDir() {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
}

// ── Deep field access by dot-path ─────────────────────────────

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o != null ? o[k] : undefined), obj);
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
    console.warn("[HTTP] Failed to save state:", err.message);
  }
}

// ── Main poller class ─────────────────────────────────────────

export class HttpSource {
  /**
   * sourceConfig shape:
   * {
   *   name: "hackernews-top",
   *   url: "https://hacker-news.firebaseio.com/v0/topstories.json",
   *   type: "http",
   *   topic: "tech-news",
   *   tags: ["tech", "hn"],
   *   pollIntervalMs: 600000,
   *   credibility: 0.8,
   *   // Field mapping (dot-paths into each item object):
   *   fields: {
   *     items: "data.children",  // path to array of items in response (null = response is array)
   *     id: "data.id",           // unique item identifier
   *     text: "data.title",      // main text content
   *     body: "data.selftext",   // optional body text (appended to text)
   *     url: "data.url",         // optional source URL
   *     date: "data.created_utc", // unix timestamp or ISO string
   *   }
   * }
   */
  constructor(sourceConfig, onMessages) {
    this.config = sourceConfig;
    this.onMessages = onMessages;
    this.state = loadState();
    this.running = false;
    this.timer = null;
  }

  async poll() {
    const { name, url, fields = {} } = this.config;
    const seenIds = new Set(this.state[name] || []);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Geoscope/1.0",
          "Accept": "application/json",
          ...(this.config.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.warn(`[HTTP:${name}] Fetch failed: ${res.status}`);
        return;
      }
      const data = await res.json();

      // Extract items array
      let items = fields.items ? getPath(data, fields.items) : data;
      if (!Array.isArray(items)) {
        console.warn(`[HTTP:${name}] Expected array at '${fields.items || "root"}', got ${typeof items}`);
        return;
      }
      items = items.slice(0, 50); // safety cap

      const newItems = [];
      for (const raw of items) {
        const id = String(fields.id ? getPath(raw, fields.id) : raw.id || raw.guid || JSON.stringify(raw).slice(0, 32));
        if (seenIds.has(id)) continue;

        const textParts = [];
        if (fields.text) {
          const t = getPath(raw, fields.text);
          if (t) textParts.push(String(t));
        }
        if (fields.body) {
          const b = getPath(raw, fields.body);
          if (b && String(b).length > 10) textParts.push(String(b).slice(0, 1000));
        }
        const text = textParts.join("\n\n").trim();
        if (!text) continue;

        const rawDate = fields.date ? getPath(raw, fields.date) : raw.created_utc || raw.pubDate || null;
        const date = rawDate
          ? typeof rawDate === "number"
            ? new Date(rawDate < 1e10 ? rawDate * 1000 : rawDate)
            : new Date(rawDate)
          : new Date();

        const link = fields.url ? getPath(raw, fields.url) : raw.url || null;

        newItems.push({ id, text, date, link });
      }

      if (newItems.length === 0) return;
      console.log(`[HTTP:${name}] ${newItems.length} new item(s)`);

      const messages = newItems.map((item) => ({
        id: Math.abs(hashCode(item.id)),
        message: item.text.slice(0, 2000),
        date: Math.floor(item.date.getTime() / 1000),
        media: null,
        fwdFrom: null,
        _httpMeta: { link: item.link, originalId: item.id },
      }));

      const updatedIds = [...seenIds, ...newItems.map((i) => i.id)];
      this.state[name] = updatedIds.slice(-500);
      saveState(this.state);

      await this.onMessages(this.config, messages);
    } catch (err) {
      console.warn(`[HTTP:${name}] Poll error: ${err.message}`);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    setTimeout(async () => {
      if (!this.running) return;
      await this.poll();
      this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    }, 15000);
    console.log(`[HTTP:${this.config.name}] Poller started (every ${this.config.pollIntervalMs / 1000}s)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function hashCode(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash;
}

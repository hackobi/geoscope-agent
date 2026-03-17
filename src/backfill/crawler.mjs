// BackfillCrawler — walks channel history backwards via offsetId pagination

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const STATE_FILE = "data/backfill-state.json";
const BATCH_SIZE = 50;
const INTER_BATCH_MS = 5000;   // 5s between batches
const INTER_CHANNEL_MS = 10000; // 10s between channels
const START_DELAY_MS = 30000;   // 30s after poller starts

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class BackfillCrawler {
  /**
   * @param {object} telegramClient — GramJS TelegramClient
   * @param {Array} channels — channel config objects from channels.json
   * @param {Function} onBatch — async (channel, messages) => void
   */
  constructor(telegramClient, channels, onBatch) {
    this.client = telegramClient;
    this.channels = channels;
    this.onBatch = onBatch;
    this.state = {};
    this.running = false;
    this.paused = false;
    this._loopPromise = null;
    this.loadState();
  }

  loadState() {
    try {
      if (existsSync(STATE_FILE)) {
        this.state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      }
    } catch {
      this.state = {};
    }
  }

  saveState() {
    try {
      const dir = dirname(STATE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn("[Backfill] Failed to save state:", err.message);
    }
  }

  /**
   * Seed a channel's starting point from the poller's lastMessageId.
   * Only seeds if we haven't started crawling this channel yet.
   */
  seedChannel(username, startId) {
    if (this.state[username]) return; // already tracking
    this.state[username] = {
      oldestSeenId: startId,
      totalProcessed: 0,
      totalEmbedded: 0,
      totalFullPipeline: 0,
      completed: false,
      lastRunTime: 0,
    };
    this.saveState();
    console.log(`[Backfill] Seeded ${username} from ID ${startId}`);
  }

  /**
   * Fetch one batch of history going backwards from oldestSeenId.
   * Returns messages array (oldest first).
   */
  async fetchHistoryBatch(channel) {
    const chState = this.state[channel.username];
    if (!chState || chState.completed) return [];

    try {
      // offsetId: fetch messages with ID < offsetId
      const messages = await this.client.getMessages(channel.username, {
        limit: BATCH_SIZE,
        offsetId: chState.oldestSeenId,
      });

      if (!messages || messages.length === 0) {
        chState.completed = true;
        chState.lastRunTime = Date.now();
        this.saveState();
        console.log(`[Backfill] ${channel.username} — completed (no more history)`);
        return [];
      }

      // Update oldestSeenId to the minimum ID in this batch
      const minId = Math.min(...messages.map((m) => m.id));
      chState.oldestSeenId = minId;
      chState.lastRunTime = Date.now();

      // Return oldest-first order
      return [...messages].reverse();
    } catch (err) {
      console.warn(`[Backfill] ${channel.username} fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Main crawl loop — iterates through channels, fetches batches, calls onBatch.
   */
  async _crawlLoop() {
    console.log(`[Backfill] Starting crawl loop (${this.channels.length} channels)`);

    while (this.running) {
      // Get channels that aren't completed
      const active = this.channels.filter((ch) => {
        const s = this.state[ch.username];
        return s && !s.completed;
      });

      if (active.length === 0) {
        console.log("[Backfill] All channels completed.");
        this.running = false;
        break;
      }

      for (const channel of active) {
        if (!this.running) break;

        // Wait while paused (yield to real-time poller)
        while (this.paused && this.running) {
          await sleep(1000);
        }
        if (!this.running) break;

        const messages = await this.fetchHistoryBatch(channel);
        if (messages.length > 0) {
          try {
            await this.onBatch(channel, messages);
          } catch (err) {
            console.error(`[Backfill] ${channel.username} batch error:`, err.message);
          }
          this.saveState();
        }

        // Inter-batch delay
        if (this.running && active.indexOf(channel) < active.length - 1) {
          await sleep(INTER_CHANNEL_MS);
        } else if (this.running) {
          await sleep(INTER_BATCH_MS);
        }
      }
    }
  }

  /**
   * Start crawling with delayed start.
   */
  start() {
    if (this.running) return;
    this.running = true;

    console.log(`[Backfill] Will start in ${START_DELAY_MS / 1000}s...`);
    this._startTimeout = setTimeout(() => {
      this._loopPromise = this._crawlLoop().catch((err) => {
        console.error("[Backfill] Loop error:", err.message);
      });
    }, START_DELAY_MS);
  }

  stop() {
    this.running = false;
    if (this._startTimeout) {
      clearTimeout(this._startTimeout);
      this._startTimeout = null;
    }
    this.saveState();
    console.log("[Backfill] Stopped.");
  }

  pause() {
    this.paused = true;
    console.log("[Backfill] Paused.");
  }

  resume() {
    this.paused = false;
    console.log("[Backfill] Resumed.");
  }

  /**
   * Update counters after a batch is processed.
   */
  updateStats(username, { full = 0, embedded = 0, processed = 0 }) {
    const s = this.state[username];
    if (!s) return;
    s.totalProcessed += processed;
    s.totalEmbedded += embedded;
    s.totalFullPipeline += full;
  }
}

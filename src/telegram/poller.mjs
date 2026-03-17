// Multi-channel staggered poller with tick-based scheduling

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const STATE_FILE = "data/poller-state.json";
const TICK_MS = 5000; // Main loop ticks every 5s
const INTER_CHANNEL_GAP_MS = 3000; // Gap between channels within a tick

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class MultiChannelPoller {
  constructor(telegramClient, channels, onMessages) {
    this.client = telegramClient;
    this.channels = channels;
    this.onMessages = onMessages;
    this.state = {}; // { channelUsername: { lastMessageId, lastPollTime } }
    this.running = false;
    this.ticking = false; // guard against overlapping ticks
    this.tickTimer = null;
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

    // Initialize state for new channels
    for (const ch of this.channels) {
      if (!this.state[ch.username]) {
        this.state[ch.username] = { lastMessageId: 0, lastPollTime: 0 };
      }
    }
  }

  saveState() {
    try {
      const dir = dirname(STATE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn("Failed to save poller state:", err.message);
    }
  }

  async fetchMessages(channel) {
    const chState = this.state[channel.username];
    try {
      const messages = await this.client.getMessages(channel.username, {
        limit: 20,
        minId: chState.lastMessageId,
      });

      // Filter new messages, process oldest first
      const newMessages = messages
        .filter((m) => m.id > chState.lastMessageId)
        .reverse();

      if (messages.length > 0) {
        const maxId = Math.max(...messages.map((m) => m.id));
        if (maxId > chState.lastMessageId) {
          chState.lastMessageId = maxId;
        }
      }

      chState.lastPollTime = Date.now();
      return newMessages;
    } catch (err) {
      console.warn(`[${channel.username}] Fetch failed: ${err.message}`);
      chState.lastPollTime = Date.now();
      return [];
    }
  }

  getDueChannels() {
    const now = Date.now();
    return this.channels.filter((ch) => {
      const chState = this.state[ch.username];
      return now - chState.lastPollTime >= ch.pollIntervalMs;
    });
  }

  async tick() {
    if (this.ticking) return; // prevent overlapping ticks
    this.ticking = true;
    try {
      await this._doTick();
    } finally {
      this.ticking = false;
    }
  }

  async _doTick() {
    const due = this.getDueChannels();
    if (due.length === 0) return;

    for (let i = 0; i < due.length; i++) {
      const channel = due[i];
      try {
        const messages = await this.fetchMessages(channel);
        if (messages.length > 0) {
          console.log(`[${channel.username}] ${messages.length} new message(s)`);
          await this.onMessages(channel, messages);
        }
      } catch (err) {
        console.error(`[${channel.username}] Error: ${err.message}`);
      }

      // Stagger between channels (rate limit safety)
      if (i < due.length - 1) {
        await sleep(INTER_CHANNEL_GAP_MS);
      }
    }

    this.saveState();
  }

  start() {
    this.running = true;
    // Initial tick
    this.tick().catch((err) => console.error("Tick error:", err.message));

    this.tickTimer = setInterval(() => {
      if (this.running) {
        this.tick().catch((err) => console.error("Tick error:", err.message));
      }
    }, TICK_MS);
  }

  getState() {
    return this.state;
  }

  stop() {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.saveState();
  }
}

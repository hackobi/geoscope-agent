import fs from "fs";
import path from "path";

export const GEOSCOPE_ROOT =
  process.env.GEOSCOPE_ROOT || path.resolve(process.cwd(), "..");

function resolvePath(relativePath: string): string {
  return path.join(GEOSCOPE_ROOT, relativePath);
}

function readJSONSafe<T>(relativePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(resolvePath(relativePath), "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readFileSafe(relativePath: string): string {
  try {
    return fs.readFileSync(resolvePath(relativePath), "utf-8");
  } catch {
    return "";
  }
}

// --- Types ---

export interface ChannelConfig {
  username: string;
  topic: string;
  tags: string[];
  pollIntervalMs: number;
  hasImages?: boolean;
}

export interface PollerState {
  [channel: string]: {
    lastMessageId: number;
    lastPollTime: number;
  };
}

export interface BackfillChannelState {
  oldestSeenId: number;
  totalProcessed: number;
  totalEmbedded: number;
  totalFullPipeline: number;
  completed: boolean;
  lastRunTime: number;
}

export interface BackfillState {
  [channel: string]: BackfillChannelState;
}

export interface PublishedPost {
  category: "ALERT" | "ANALYSIS" | "OBSERVATION";
  text: string;
  txUrl: string | null;
  timestamp: string;
  channel: string | null;
  confidence?: number;
  messageId?: number;
}

export interface FeedFilters {
  category?: "ALERT" | "ANALYSIS" | "OBSERVATION";
  minConfidence?: number;
  maxConfidence?: number;
}

export interface LogStats {
  wallet: string | null;
  balance: string | null;
  publishedPosts: PublishedPost[];
  retroLinksCount: number;
  categoryCounts: { ALERT: number; ANALYSIS: number; OBSERVATION: number };
}

export interface ChannelConfigWithCredibility extends ChannelConfig {
  credibility?: number;
}

export interface AgentRecord {
  agentId: string;
  name: string;
  type: string;
  host: string;
  status: "running" | "stale" | "offline";
  uptimeMs: number;
  channels: number;
  externalSources: number;
  stats: { totalPublished: number; totalEmbedded: number; alertCount: number };
  lastActivity: number;
  lastHeartbeat: number;
  registeredAt: number;
}

export interface Story {
  id: string;
  title: string;
  topic: string;
  firstSeen: number;
  lastSeen: number;
  postCount: number;
  hasAlert: boolean;
  archived: boolean;
  channels: string[];
  posts: Array<{ channel: string; messageId: number; similarity: number; addedAt: number }>;
}

export interface StatusResponse {
  alive: boolean;
  pid: number | null;
  wallet: string | null;
  balance: string | null;
  channels: ChannelConfig[];
  pollerState: PollerState;
  backfillState: BackfillState;
  stats: {
    totalPublished: number;
    totalEmbedded: number;
    retroLinksCount: number;
    categoryCounts: { ALERT: number; ANALYSIS: number; OBSERVATION: number };
  };
}

// --- PID Check ---

export function isAgentAlive(): { alive: boolean; pid: number | null } {
  try {
    const pidStr = fs.readFileSync(resolvePath(".geoscope.pid"), "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return { alive: false, pid: null };
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

// --- Data Readers ---

export function getChannels(): ChannelConfig[] {
  const data = readJSONSafe<{ channels?: ChannelConfig[] } | ChannelConfig[]>(
    "channels.json",
    { channels: [] }
  );
  if (Array.isArray(data)) return data;
  return data.channels || [];
}

export function getPollerState(): PollerState {
  return readJSONSafe<PollerState>("data/poller-state.json", {});
}

export function getBackfillState(): BackfillState {
  return readJSONSafe<BackfillState>("data/backfill-state.json", {});
}

// --- Log Parsing ---

const RE_WALLET = /Connected to Demos as (0x[a-f0-9]+)/;
const RE_BALANCE = /Balance: ([\d.]+) DEM/;
const RE_PUBLISHED = /Published \[(ALERT|ANALYSIS|OBSERVATION)\]: (.+)/;
const RE_TX = /tx: (https:\/\/scan\.demos\.network\/transactions\/[a-f0-9]+)/;
const RE_TIMESTAMP = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+)\]/;
const RE_CHANNEL_CONTEXT = /\[(\w+)\] Processing msg/;
const RE_RETROLINK = /\[RetroLink\]/;
const RE_CONFIDENCE = /confidence[:\s]+(\d+)/i;

export function parseLogStats(): LogStats {
  const log = readFileSafe("logs/geoscope-production.log");
  if (!log) {
    return {
      wallet: null,
      balance: null,
      publishedPosts: [],
      retroLinksCount: 0,
      categoryCounts: { ALERT: 0, ANALYSIS: 0, OBSERVATION: 0 },
    };
  }

  const lines = log.split("\n");
  let wallet: string | null = null;
  let balance: string | null = null;
  let retroLinksCount = 0;
  const categoryCounts = { ALERT: 0, ANALYSIS: 0, OBSERVATION: 0 };
  const posts: PublishedPost[] = [];
  let currentChannel: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!wallet) {
      const wm = line.match(RE_WALLET);
      if (wm) wallet = wm[1];
    }

    const bm = line.match(RE_BALANCE);
    if (bm) balance = bm[1];

    const cm = line.match(RE_CHANNEL_CONTEXT);
    if (cm) currentChannel = cm[1];

    if (RE_RETROLINK.test(line)) retroLinksCount++;

    const pm = line.match(RE_PUBLISHED);
    if (pm) {
      const category = pm[1] as "ALERT" | "ANALYSIS" | "OBSERVATION";
      categoryCounts[category]++;
      const tm = line.match(RE_TIMESTAMP);
      let txUrl: string | null = null;
      let confidence: number | undefined;

      // Look ahead for tx URL and confidence (usually next few lines)
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const txm = lines[j].match(RE_TX);
        if (txm) {
          txUrl = txm[1];
        }
        const confm = lines[j].match(RE_CONFIDENCE);
        if (confm) {
          confidence = parseInt(confm[1], 10);
        }
        // Stop looking if we hit another Published line
        if (RE_PUBLISHED.test(lines[j])) break;
      }

      posts.push({
        category,
        text: pm[2],
        txUrl,
        timestamp: tm ? tm[1] : "",
        channel: currentChannel,
        confidence,
      });
    }
  }

  return { wallet, balance, publishedPosts: posts, retroLinksCount, categoryCounts };
}

export function getStatus(): StatusResponse {
  const { alive, pid } = isAgentAlive();
  const channels = getChannels();
  const pollerState = getPollerState();
  const backfillState = getBackfillState();
  const logStats = parseLogStats();

  let totalEmbedded = 0;
  for (const ch of Object.values(backfillState)) {
    totalEmbedded += ch.totalEmbedded;
  }

  return {
    alive,
    pid,
    wallet: logStats.wallet,
    balance: logStats.balance,
    channels,
    pollerState,
    backfillState,
    stats: {
      totalPublished: logStats.publishedPosts.length,
      totalEmbedded,
      retroLinksCount: logStats.retroLinksCount,
      categoryCounts: logStats.categoryCounts,
    },
  };
}

export function getFeed(limit = 100, filters?: FeedFilters): PublishedPost[] {
  const { publishedPosts } = parseLogStats();
  let filtered = publishedPosts;

  if (filters) {
    if (filters.category) {
      filtered = filtered.filter((p) => p.category === filters.category);
    }
    if (filters.minConfidence !== undefined) {
      filtered = filtered.filter(
        (p) => p.confidence !== undefined && p.confidence >= filters.minConfidence!
      );
    }
    if (filters.maxConfidence !== undefined) {
      filtered = filtered.filter(
        (p) => p.confidence !== undefined && p.confidence <= filters.maxConfidence!
      );
    }
  }

  return filtered.reverse().slice(0, limit);
}

export function getLogFilePath(): string {
  return resolvePath("logs/geoscope-production.log");
}

"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// --- Types (mirrored from server) ---

interface ChannelConfig {
  username: string;
  topic: string;
  tags: string[];
  pollIntervalMs: number;
}

interface PollerState {
  [channel: string]: { lastMessageId: number; lastPollTime: number };
}

interface BackfillChannelState {
  totalProcessed: number;
  totalEmbedded: number;
  totalFullPipeline: number;
  completed: boolean;
}

interface BackfillState {
  [channel: string]: BackfillChannelState;
}

interface StatusData {
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

interface FeedPost {
  category: "ALERT" | "ANALYSIS" | "OBSERVATION";
  text: string;
  txUrl: string | null;
  timestamp: string;
  channel: string | null;
}

interface SearchResult {
  channel: string;
  messageId: number;
  text: string;
  timestamp: number;
  topic: string;
  similarity: number;
}

// --- Helpers ---

function relativeTime(ts: number | string): string {
  const now = Date.now();
  const then = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const diff = now - then;
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function countdown(lastPoll: number, intervalMs: number): string {
  const next = lastPoll + intervalMs;
  const remaining = next - Date.now();
  if (remaining <= 0) return "polling...";
  const secs = Math.ceil(remaining / 1000);
  return `${secs}s`;
}

function truncateWallet(addr: string): string {
  return addr.slice(0, 8) + "..." + addr.slice(-6);
}

const CATEGORY_COLORS = {
  ALERT: "bg-cockpit-alert",
  ANALYSIS: "bg-cockpit-analysis",
  OBSERVATION: "bg-cockpit-observation",
} as const;

const TOPIC_COLORS: Record<string, string> = {
  geopolitics: "bg-blue-800/60 text-blue-300",
  "breaking-news": "bg-red-800/60 text-red-300",
  "geopolitics-russia": "bg-orange-800/60 text-orange-300",
  "crypto-culture": "bg-purple-800/60 text-purple-300",
  "geopolitics-intelligence": "bg-emerald-800/60 text-emerald-300",
};

// --- Donut Chart Component ---

function DonutChart({
  data,
}: {
  data: { ALERT: number; ANALYSIS: number; OBSERVATION: number };
}) {
  const total = data.ALERT + data.ANALYSIS + data.OBSERVATION;
  if (total === 0) {
    return (
      <svg viewBox="0 0 100 100" className="w-32 h-32">
        <circle
          cx="50" cy="50" r="40"
          fill="none" stroke="#1e2b1e" strokeWidth="12"
        />
        <text x="50" y="54" textAnchor="middle" fill="#6b8f6b" fontSize="12">
          0
        </text>
      </svg>
    );
  }

  const segments = [
    { key: "ALERT", value: data.ALERT, color: "#ef4444" },
    { key: "ANALYSIS", value: data.ANALYSIS, color: "#f59e0b" },
    { key: "OBSERVATION", value: data.OBSERVATION, color: "#22c55e" },
  ].filter((s) => s.value > 0);

  const circumference = 2 * Math.PI * 40;
  let offset = 0;

  return (
    <svg viewBox="0 0 100 100" className="w-32 h-32">
      {segments.map((seg) => {
        const pct = seg.value / total;
        const dashArray = `${pct * circumference} ${circumference}`;
        const dashOffset = -offset * circumference;
        offset += pct;
        return (
          <circle
            key={seg.key}
            cx="50" cy="50" r="40"
            fill="none"
            stroke={seg.color}
            strokeWidth="12"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 50 50)"
          />
        );
      })}
      <text x="50" y="54" textAnchor="middle" fill="#d4e5d4" fontSize="14" fontFamily="monospace">
        {total}
      </text>
    </svg>
  );
}

// --- Log Line Component ---

function LogLine({ line }: { line: string }) {
  let color = "text-cockpit-muted";
  if (line.includes("[ERROR]") || line.includes("Error")) color = "text-cockpit-alert";
  else if (line.includes("[WARN]") || line.includes("warn")) color = "text-cockpit-analysis";
  else if (line.includes("Published")) color = "text-cockpit-observation";
  else if (line.includes("[INFO]")) color = "text-cockpit-accent";

  // Strip ANSI codes
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "");

  return <div className={`${color} text-xs leading-relaxed break-all`}>{clean}</div>;
}

// --- Main Dashboard ---

export default function Dashboard() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [feed, setFeed] = useState<FeedPost[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Related messages state (keyed by feed post index)
  const [relatedMap, setRelatedMap] = useState<Record<number, SearchResult[]>>({});
  const [relatedLoading, setRelatedLoading] = useState<Record<number, boolean>>({});

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) setStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Fetch feed
  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch("/api/feed");
      if (res.ok) setFeed(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Initial load + polling
  useEffect(() => {
    fetchStatus();
    fetchFeed();
    const statusInterval = setInterval(fetchStatus, 10000);
    const feedInterval = setInterval(fetchFeed, 15000);
    // Tick for countdown timers
    const tickInterval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(statusInterval);
      clearInterval(feedInterval);
      clearInterval(tickInterval);
    };
  }, [fetchStatus, fetchFeed]);

  // SSE log stream
  useEffect(() => {
    const es = new EventSource("/api/logs");
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      try {
        const { line } = JSON.parse(event.data);
        setLogLines((prev) => {
          const next = [...prev, line];
          return next.slice(-100);
        });
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const copyWallet = () => {
    if (status?.wallet) {
      navigator.clipboard.writeText(status.wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: q, limit: 10 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setSearchResults(data.results || []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const fetchRelated = async (postIndex: number, postText: string) => {
    if (relatedMap[postIndex]) {
      // toggle off
      setRelatedMap((prev) => {
        const next = { ...prev };
        delete next[postIndex];
        return next;
      });
      return;
    }
    setRelatedLoading((prev) => ({ ...prev, [postIndex]: true }));
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: postText.slice(0, 500), limit: 5 }),
      });
      const data = await res.json();
      setRelatedMap((prev) => ({ ...prev, [postIndex]: data.results || [] }));
    } catch {
      // silently fail
    } finally {
      setRelatedLoading((prev) => ({ ...prev, [postIndex]: false }));
    }
  };

  if (!status) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cockpit-bg">
        <div className="text-cockpit-muted font-mono text-lg animate-pulse">
          INITIALIZING COCKPIT...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cockpit-bg p-4 max-w-[1600px] mx-auto">
      {/* === HEADER === */}
      <header className="flex items-center justify-between mb-6 border-b border-cockpit-border pb-4">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-xl tracking-[0.3em] uppercase text-cockpit-text font-bold">
            GEOSCOPE COCKPIT
          </h1>
          <span
            className={`px-3 py-1 rounded-full text-xs font-mono font-bold uppercase tracking-wider ${
              status.alive
                ? "bg-cockpit-observation/20 text-cockpit-observation"
                : "bg-cockpit-alert/20 text-cockpit-alert"
            }`}
          >
            {status.alive ? "LIVE" : "STOPPED"}
          </span>
        </div>
        <div className="flex items-center gap-6 text-sm font-mono">
          {status.wallet && (
            <button
              onClick={copyWallet}
              className="flex items-center gap-2 text-cockpit-muted hover:text-cockpit-text transition"
              title="Copy wallet address"
            >
              <span className="text-cockpit-accent">{truncateWallet(status.wallet)}</span>
              <span className="text-xs">{copied ? "copied!" : "copy"}</span>
            </button>
          )}
          {status.balance && (
            <span className="text-cockpit-text">
              <span className="text-cockpit-muted mr-1">BAL</span>
              {status.balance} DEM
            </span>
          )}
          {status.pid && (
            <span className="text-cockpit-muted">
              PID {status.pid}
            </span>
          )}
        </div>
      </header>

      {/* === CHANNEL CARDS === */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 mb-6">
        {status.channels.map((ch) => {
          const poller = status.pollerState[ch.username];
          const isRecent = poller
            ? Date.now() - poller.lastPollTime < ch.pollIntervalMs * 2
            : false;

          return (
            <div
              key={ch.username}
              className={`bg-cockpit-card border border-cockpit-border rounded-lg p-4 ${
                isRecent ? "border-cockpit-accent/50" : ""
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-sm text-cockpit-text font-semibold">
                  @{ch.username}
                </span>
                {isRecent && (
                  <span className="w-2 h-2 rounded-full bg-cockpit-observation animate-pulse-green" />
                )}
              </div>
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs font-mono mb-2 ${
                  TOPIC_COLORS[ch.topic] || "bg-cockpit-border text-cockpit-muted"
                }`}
              >
                {ch.topic}
              </span>
              <div className="flex flex-wrap gap-1 mb-3">
                {ch.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 bg-cockpit-bg rounded text-[10px] text-cockpit-muted font-mono"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              {poller ? (
                <div className="space-y-1 text-xs font-mono text-cockpit-muted">
                  <div className="flex justify-between">
                    <span>Last poll</span>
                    <span className="text-cockpit-text">{relativeTime(poller.lastPollTime)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Next in</span>
                    <span className="text-cockpit-accent">
                      {countdown(poller.lastPollTime, ch.pollIntervalMs)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Last msg</span>
                    <span className="text-cockpit-text">#{poller.lastMessageId}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-cockpit-muted font-mono">No poll data</div>
              )}
            </div>
          );
        })}
      </section>

      {/* === STATS + BACKFILL ROW === */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Stats Panel */}
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-4">
            Statistics
          </h2>
          <div className="flex items-start gap-6">
            <DonutChart data={status.stats.categoryCounts} />
            <div className="flex-1 space-y-3">
              <StatRow label="Published" value={status.stats.totalPublished} />
              <StatRow label="Embedded" value={status.stats.totalEmbedded} />
              <StatRow label="RetroLinks" value={status.stats.retroLinksCount} />
              <div className="border-t border-cockpit-border pt-2 mt-2 space-y-1">
                <CategoryRow label="ALERT" count={status.stats.categoryCounts.ALERT} color="text-cockpit-alert" />
                <CategoryRow label="ANALYSIS" count={status.stats.categoryCounts.ANALYSIS} color="text-cockpit-analysis" />
                <CategoryRow label="OBSERVATION" count={status.stats.categoryCounts.OBSERVATION} color="text-cockpit-observation" />
              </div>
            </div>
          </div>
        </div>

        {/* Backfill Progress */}
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-4">
            Backfill Progress
          </h2>
          <div className="space-y-3">
            {Object.entries(status.backfillState).map(([channel, bf]) => (
              <BackfillBar key={channel} channel={channel} data={bf} />
            ))}
            {Object.keys(status.backfillState).length === 0 && (
              <div className="text-xs text-cockpit-muted font-mono">No backfill data</div>
            )}
          </div>
        </div>
      </div>

      {/* === SEARCH PANEL === */}
      <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5 mb-6">
        <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-4">
          Semantic Search
        </h2>
        <form onSubmit={handleSearch} className="flex gap-2 mb-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search embedded messages..."
            className="flex-1 bg-cockpit-bg border border-cockpit-border rounded px-3 py-2 text-sm font-mono text-cockpit-text placeholder:text-cockpit-muted/50 focus:outline-none focus:border-cockpit-accent"
          />
          <button
            type="submit"
            disabled={searchLoading || !searchQuery.trim()}
            className="px-4 py-2 bg-cockpit-accent/20 border border-cockpit-accent/50 rounded text-xs font-mono text-cockpit-accent hover:bg-cockpit-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {searchLoading ? "Searching..." : "Search"}
          </button>
        </form>
        {searchError && (
          <div className="text-xs font-mono text-cockpit-alert mb-2">{searchError}</div>
        )}
        {searchResults.length > 0 && (
          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
            {searchResults.map((r, i) => (
              <div key={i} className="border-b border-cockpit-border/50 pb-2 last:border-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-mono text-cockpit-muted">@{r.channel}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      TOPIC_COLORS[r.topic] || "bg-cockpit-border text-cockpit-muted"
                    }`}
                  >
                    {r.topic}
                  </span>
                  <span className="text-[10px] font-mono text-cockpit-accent ml-auto">
                    {(r.similarity * 100).toFixed(1)}%
                  </span>
                  <span className="text-[10px] font-mono text-cockpit-muted">
                    {r.timestamp ? relativeTime(r.timestamp) : ""}
                  </span>
                </div>
                <p className="text-xs text-cockpit-text/80 leading-relaxed">
                  {r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text}
                </p>
              </div>
            ))}
          </div>
        )}
        {!searchLoading && searchResults.length === 0 && searchQuery && !searchError && (
          <div className="text-xs text-cockpit-muted font-mono">No results</div>
        )}
      </div>

      {/* === FEED + LOG ROW === */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Intelligence Feed */}
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-4">
            Intelligence Feed
          </h2>
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {feed.length === 0 && (
              <div className="text-xs text-cockpit-muted font-mono">No published posts yet</div>
            )}
            {feed.map((post, i) => (
              <div
                key={i}
                className="border-b border-cockpit-border/50 pb-2 last:border-0"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${CATEGORY_COLORS[post.category]} text-white`}
                  >
                    {post.category}
                  </span>
                  {post.channel && (
                    <span className="text-[10px] font-mono text-cockpit-muted">
                      @{post.channel}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-cockpit-muted ml-auto">
                    {post.timestamp ? relativeTime(post.timestamp) : ""}
                  </span>
                </div>
                <p className="text-xs text-cockpit-text/80 leading-relaxed">
                  {post.text.length > 200 ? post.text.slice(0, 200) + "..." : post.text}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  {post.txUrl && (
                    <a
                      href={post.txUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-mono text-cockpit-accent hover:underline"
                    >
                      tx &rarr;
                    </a>
                  )}
                  <button
                    onClick={() => fetchRelated(i, post.text)}
                    disabled={relatedLoading[i]}
                    className="text-[10px] font-mono text-cockpit-muted hover:text-cockpit-accent transition disabled:opacity-40"
                  >
                    {relatedLoading[i] ? "loading..." : relatedMap[i] ? "hide related" : "related"}
                  </button>
                </div>
                {relatedMap[i] && relatedMap[i].length > 0 && (
                  <div className="mt-2 ml-3 pl-3 border-l border-cockpit-accent/30 space-y-1.5">
                    {relatedMap[i].map((r, j) => (
                      <div key={j} className="text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-cockpit-muted">@{r.channel}</span>
                          <span
                            className={`px-1 py-0.5 rounded text-[9px] font-mono ${
                              TOPIC_COLORS[r.topic] || "bg-cockpit-border text-cockpit-muted"
                            }`}
                          >
                            {r.topic}
                          </span>
                          <span className="font-mono text-cockpit-accent ml-auto">
                            {(r.similarity * 100).toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-cockpit-text/60 leading-relaxed">
                          {r.text.length > 150 ? r.text.slice(0, 150) + "..." : r.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                {relatedMap[i] && relatedMap[i].length === 0 && (
                  <div className="mt-1 ml-3 text-[10px] font-mono text-cockpit-muted">
                    No related messages found
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Live Log Tail */}
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-4">
            Live Log
          </h2>
          <div
            ref={logRef}
            className="bg-cockpit-bg rounded p-3 max-h-[500px] overflow-y-auto font-mono"
          >
            {logLines.length === 0 && (
              <div className="text-xs text-cockpit-muted">Waiting for log data...</div>
            )}
            {logLines.map((line, i) => (
              <LogLine key={i} line={line} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs font-mono text-cockpit-muted uppercase tracking-wider">
        {label}
      </span>
      <span className="text-lg font-mono font-bold text-cockpit-text">{value.toLocaleString()}</span>
    </div>
  );
}

function CategoryRow({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex justify-between items-center text-xs font-mono">
      <span className={color}>{label}</span>
      <span className="text-cockpit-text">{count}</span>
    </div>
  );
}

function BackfillBar({ channel, data }: { channel: string; data: BackfillChannelState }) {
  const maxVal = Math.max(data.totalProcessed, 1);
  const embedPct = (data.totalEmbedded / maxVal) * 100;
  const pipelinePct = (data.totalFullPipeline / maxVal) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono text-cockpit-text">@{channel}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-cockpit-muted">
            {data.totalProcessed.toLocaleString()} proc
          </span>
          <span className="text-[10px] font-mono text-cockpit-accent">
            {data.totalEmbedded.toLocaleString()} emb
          </span>
          <span className="text-[10px] font-mono text-cockpit-analysis">
            {data.totalFullPipeline} full
          </span>
          {data.completed ? (
            <span className="text-cockpit-observation text-xs">&#10003;</span>
          ) : (
            <span className="text-cockpit-analysis text-xs animate-pulse">&#9679;</span>
          )}
        </div>
      </div>
      <div className="h-1.5 bg-cockpit-bg rounded-full overflow-hidden">
        <div
          className="h-full bg-cockpit-accent/40 rounded-full relative"
          style={{ width: `${Math.min(embedPct, 100)}%` }}
        >
          <div
            className="absolute inset-y-0 left-0 bg-cockpit-observation rounded-full"
            style={{ width: `${pipelinePct > 0 ? Math.max((pipelinePct / embedPct) * 100, 2) : 0}%` }}
          />
        </div>
      </div>
    </div>
  );
}

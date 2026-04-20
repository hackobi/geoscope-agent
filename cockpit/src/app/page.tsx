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
  "food-security": "bg-amber-800/60 text-amber-300",
  "geopolitics-brics": "bg-teal-800/60 text-teal-300",
  "geopolitics-africa": "bg-yellow-800/60 text-yellow-300",
  "geopolitics-conflict": "bg-rose-800/60 text-rose-300",
  "geopolitics-asia": "bg-cyan-800/60 text-cyan-300",
  "tech-news": "bg-indigo-800/60 text-indigo-300",
  "cybersecurity": "bg-red-900/60 text-red-400",
  "tech-projects": "bg-violet-800/60 text-violet-300",
  // SuperColony chain categories
  observation: "bg-cyan-800/60 text-cyan-300",
  analysis: "bg-blue-800/60 text-blue-300",
  prediction: "bg-fuchsia-800/60 text-fuchsia-300",
  alert: "bg-red-800/60 text-red-300",
  action: "bg-orange-800/60 text-orange-300",
  signal: "bg-emerald-800/60 text-emerald-300",
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

  // Live balance
  const [liveBalance, setLiveBalance] = useState<number | null>(null);

  // Faucet state
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Related messages state (keyed by feed post index)
  const [relatedMap, setRelatedMap] = useState<Record<number, SearchResult[]>>({});
  const [relatedLoading, setRelatedLoading] = useState<Record<number, boolean>>({});

  // Analysis state
  const [analysisPrompt, setAnalysisPrompt] = useState("");
  const [analysisResponse, setAnalysisResponse] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisSources, setAnalysisSources] = useState<Array<{
    channel: string;
    topic: string;
    similarity: number;
    timestamp: number;
    textPreview: string;
  }>>([]);
  const [showSources, setShowSources] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const [analysisQueries, setAnalysisQueries] = useState<string[]>([]);
  const [showQueries, setShowQueries] = useState(false);
  const [analysisModel, setAnalysisModel] = useState("minimax-m1");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; label: string }>>([]);

  // Chain feed state
  const [chainFeed, setChainFeed] = useState<Array<{
    channel: string;
    messageId: number;
    text: string;
    timestamp: number;
    topic: string;
    author: string;
  }>>([]);
  const [chainStats, setChainStats] = useState<{
    totalPosts: number;
    categories: Record<string, number>;
    lastIngested: number | null;
  } | null>(null);
  const [chainFilter, setChainFilter] = useState("");
  const [chainRelatedMap, setChainRelatedMap] = useState<Record<number, SearchResult[]>>({});
  const [chainRelatedLoading, setChainRelatedLoading] = useState<Record<number, boolean>>({});

  // Stories state
  const [stories, setStories] = useState<Array<{
    id: string;
    title: string;
    topic: string;
    firstSeen: number;
    lastSeen: number;
    postCount: number;
    hasAlert: boolean;
    channels: string[];
  }>>([]);

  // Agent mesh state
  const [agents, setAgents] = useState<Array<{
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
  }>>([]);

  // Chain monitor state
  const [chainMonitor, setChainMonitor] = useState<{
    blockNumber: number;
    blockRate: number;
    blocks: Array<{ number: number; hash: string; timestamp: number; txCount: number; proposer: string }>;
    mempoolSize: number;
    mempoolTypes: Record<string, number>;
    rpcNode: string;
    timestamp: number;
  } | null>(null);
  const [prevBlockNumber, setPrevBlockNumber] = useState<number | null>(null);

  // Identity resolution state
  const [identityQuery, setIdentityQuery] = useState("");
  const [identityMode, setIdentityMode] = useState<"address" | "twitter" | "telegram" | "github" | "discord">("address");
  const [identityResult, setIdentityResult] = useState<{
    address?: string;
    web2?: Record<string, unknown>;
    xm?: Record<string, unknown>;
    pqc?: Record<string, unknown>;
    ud?: unknown[];
    hasLinks?: boolean;
    platform?: string;
    handle?: string;
    addresses?: string[];
    error?: string;
  } | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) setStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Fetch live balance from chain
  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/balance");
      if (res.ok) {
        const data = await res.json();
        if (data.balance !== null) setLiveBalance(data.balance);
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch feed
  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch("/api/feed");
      if (res.ok) setFeed(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Fetch chain feed
  const fetchChainFeed = useCallback(async () => {
    try {
      const url = chainFilter
        ? `/api/chain-feed?category=${chainFilter}`
        : "/api/chain-feed";
      const res = await fetch(url);
      if (res.ok) setChainFeed(await res.json());
    } catch { /* ignore */ }
  }, [chainFilter]);

  // Fetch chain stats
  const fetchChainStats = useCallback(async () => {
    try {
      const res = await fetch("/api/chain-stats");
      if (res.ok) setChainStats(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Fetch stories
  const fetchStories = useCallback(async () => {
    try {
      const res = await fetch("/api/stories");
      if (res.ok) {
        const data = await res.json();
        setStories(data.stories || []);
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch agent mesh
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents || []);
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch chain monitor
  const fetchChainMonitor = useCallback(async () => {
    try {
      const res = await fetch("/api/chain-monitor");
      if (res.ok) {
        const data = await res.json();
        setChainMonitor((prev) => {
          if (prev) setPrevBlockNumber(prev.blockNumber);
          return data;
        });
      }
    } catch { /* ignore */ }
  }, []);

  // Resolve identity
  const handleIdentitySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = identityQuery.trim();
    if (!q) return;
    setIdentityLoading(true);
    setIdentityResult(null);
    try {
      const res = await fetch(`/api/identity?${identityMode}=${encodeURIComponent(q)}`);
      const data = await res.json();
      setIdentityResult(data);
    } catch {
      setIdentityResult({ error: "Query failed" });
    } finally {
      setIdentityLoading(false);
    }
  };

  // Related for chain posts
  const fetchChainRelated = async (postIndex: number, postText: string) => {
    if (chainRelatedMap[postIndex]) {
      setChainRelatedMap((prev) => {
        const next = { ...prev };
        delete next[postIndex];
        return next;
      });
      return;
    }
    setChainRelatedLoading((prev) => ({ ...prev, [postIndex]: true }));
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: postText.slice(0, 500), limit: 5 }),
      });
      const data = await res.json();
      setChainRelatedMap((prev) => ({ ...prev, [postIndex]: data.results || [] }));
    } catch { /* ignore */ }
    finally {
      setChainRelatedLoading((prev) => ({ ...prev, [postIndex]: false }));
    }
  };

  // Initial load + polling
  useEffect(() => {
    fetchStatus();
    fetchFeed();
    fetchBalance();
    fetchChainFeed();
    fetchChainStats();
    fetchChainMonitor();
    fetchStories();
    fetchAgents();
    // Load available models
    fetch("/api/analyze").then(r => r.json()).then(data => {
      if (data.models) setAvailableModels(data.models);
      if (data.default) setAnalysisModel(data.default);
    }).catch(() => {});
    const statusInterval = setInterval(fetchStatus, 10000);
    const feedInterval = setInterval(fetchFeed, 15000);
    const balanceInterval = setInterval(fetchBalance, 30000);
    const chainFeedInterval = setInterval(fetchChainFeed, 30000);
    const chainStatsInterval = setInterval(fetchChainStats, 60000);
    const chainMonitorInterval = setInterval(fetchChainMonitor, 10000);
    const storiesInterval = setInterval(fetchStories, 30000);
    const agentsInterval = setInterval(fetchAgents, 15000);
    // Tick for countdown timers
    const tickInterval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(statusInterval);
      clearInterval(feedInterval);
      clearInterval(balanceInterval);
      clearInterval(chainFeedInterval);
      clearInterval(chainStatsInterval);
      clearInterval(chainMonitorInterval);
      clearInterval(storiesInterval);
      clearInterval(agentsInterval);
      clearInterval(tickInterval);
    };
  }, [fetchStatus, fetchFeed, fetchChainFeed, fetchChainStats, fetchChainMonitor, fetchStories, fetchAgents]);

  // Re-fetch chain feed when filter changes
  useEffect(() => {
    fetchChainFeed();
  }, [fetchChainFeed]);

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

  const requestFaucet = async () => {
    setFaucetLoading(true);
    setFaucetMsg(null);
    try {
      const res = await fetch("/api/faucet", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFaucetMsg(`+${data.amount} DEM`);
      setTimeout(() => setFaucetMsg(null), 4000);
      fetchBalance();
    } catch (err) {
      setFaucetMsg(err instanceof Error ? err.message : "Failed");
      setTimeout(() => setFaucetMsg(null), 4000);
    } finally {
      setFaucetLoading(false);
    }
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = analysisPrompt.trim();
    if (!prompt) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    setAnalysisResponse("");
    setAnalysisSources([]);
    setShowSources(false);
    setAnalysisStatus(null);
    setAnalysisQueries([]);
    setShowQueries(false);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, model: analysisModel }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Analysis failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "status") {
              setAnalysisStatus(event.message);
            } else if (event.type === "queries") {
              setAnalysisQueries(event.queries);
              setAnalysisStatus(null);
            } else if (event.type === "context") {
              setAnalysisSources(event.sources);
              setAnalysisStatus(null);
            } else if (event.type === "text") {
              setAnalysisResponse((prev) => prev + event.text);
            } else if (event.type === "error") {
              setAnalysisError(event.error);
            }
          } catch {
            // skip malformed events
          }
        }
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalysisLoading(false);
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
          <span className="text-cockpit-text">
            <span className="text-cockpit-muted mr-1">BAL</span>
            {liveBalance !== null ? liveBalance.toLocaleString() : (status.balance || "...")} DEM
          </span>
          {status.wallet && (
            <button
              onClick={requestFaucet}
              disabled={faucetLoading}
              className="px-3 py-1 bg-cockpit-observation/20 border border-cockpit-observation/50 rounded text-xs font-mono text-cockpit-observation hover:bg-cockpit-observation/30 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {faucetLoading ? "Requesting..." : faucetMsg || "Get DEM"}
            </button>
          )}
          {status.pid && (
            <span className="text-cockpit-muted">
              PID {status.pid}
            </span>
          )}
        </div>
      </header>

      {/* === CHAIN MONITOR === */}
      {chainMonitor && (
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-4 mb-6">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted">
              Demos Chain
            </h2>
            <span className="text-[10px] font-mono text-cockpit-muted/60">
              {chainMonitor.rpcNode}
            </span>
          </div>

          {/* Top stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            {/* Block height */}
            <div>
              <div className="text-[10px] font-mono text-cockpit-muted uppercase tracking-wider mb-1">Block Height</div>
              <div className="text-2xl font-mono font-bold text-cockpit-text">
                {chainMonitor.blockNumber.toLocaleString()}
              </div>
              {prevBlockNumber && prevBlockNumber !== chainMonitor.blockNumber && (
                <div className="text-[10px] font-mono text-cockpit-observation">
                  +{chainMonitor.blockNumber - prevBlockNumber} since last check
                </div>
              )}
            </div>

            {/* Block rate */}
            <div>
              <div className="text-[10px] font-mono text-cockpit-muted uppercase tracking-wider mb-1">Block Rate</div>
              <div className="text-2xl font-mono font-bold text-cockpit-text">
                {chainMonitor.blockRate}
                <span className="text-sm text-cockpit-muted ml-1">/min</span>
              </div>
              <div className={`text-[10px] font-mono ${
                chainMonitor.blockRate >= 5 ? "text-cockpit-observation" :
                chainMonitor.blockRate >= 2 ? "text-cockpit-analysis" :
                "text-cockpit-alert"
              }`}>
                {chainMonitor.blockRate >= 5 ? "healthy" :
                 chainMonitor.blockRate >= 2 ? "slow" : "degraded"}
              </div>
            </div>

            {/* Mempool */}
            <div>
              <div className="text-[10px] font-mono text-cockpit-muted uppercase tracking-wider mb-1">Mempool</div>
              <div className="text-2xl font-mono font-bold text-cockpit-text">
                {chainMonitor.mempoolSize.toLocaleString()}
                <span className="text-sm text-cockpit-muted ml-1">txs</span>
              </div>
              <div className="flex gap-2 mt-0.5">
                {Object.entries(chainMonitor.mempoolTypes).map(([type, count]) => (
                  <span key={type} className="text-[9px] font-mono text-cockpit-muted">
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>

            {/* Avg block time */}
            <div>
              <div className="text-[10px] font-mono text-cockpit-muted uppercase tracking-wider mb-1">Avg Block Time</div>
              <div className="text-2xl font-mono font-bold text-cockpit-text">
                {chainMonitor.blockRate > 0
                  ? (60 / chainMonitor.blockRate).toFixed(1)
                  : "—"}
                <span className="text-sm text-cockpit-muted ml-1">sec</span>
              </div>
            </div>
          </div>

          {/* Recent blocks strip */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {chainMonitor.blocks.slice().reverse().map((block) => (
              <div
                key={block.number}
                className="flex-shrink-0 bg-cockpit-bg border border-cockpit-border/50 rounded px-2 py-1.5 min-w-[100px]"
              >
                <div className="text-[10px] font-mono text-cockpit-accent font-bold">
                  #{block.number.toLocaleString()}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[9px] font-mono ${
                    block.txCount > 0 ? "text-cockpit-observation" : "text-cockpit-muted/50"
                  }`}>
                    {block.txCount} tx{block.txCount !== 1 ? "s" : ""}
                  </span>
                  <span className="text-[9px] font-mono text-cockpit-muted">
                    {block.timestamp ? relativeTime(block.timestamp * 1000) : ""}
                  </span>
                </div>
                <div className="text-[8px] font-mono text-cockpit-muted/40 mt-0.5">
                  {block.hash}...
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === AGENT MESH === */}
      {agents.length > 0 && (
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-4 mb-6">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-3">
            Agent Mesh — {agents.length} agent{agents.length !== 1 ? "s" : ""}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map((agent) => {
              const statusColor =
                agent.status === "running"
                  ? "text-cockpit-observation border-cockpit-observation/30"
                  : agent.status === "stale"
                  ? "text-cockpit-analysis border-cockpit-analysis/30"
                  : "text-cockpit-alert border-cockpit-alert/30";
              const dotColor =
                agent.status === "running"
                  ? "bg-cockpit-observation"
                  : agent.status === "stale"
                  ? "bg-cockpit-analysis"
                  : "bg-cockpit-alert";
              const uptimeMins = Math.floor(agent.uptimeMs / 60000);
              const uptimeStr =
                uptimeMins < 60
                  ? `${uptimeMins}m`
                  : `${Math.floor(uptimeMins / 60)}h ${uptimeMins % 60}m`;
              return (
                <div
                  key={agent.agentId}
                  className={`bg-cockpit-bg border rounded-lg p-3 ${statusColor}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${dotColor} animate-pulse`} />
                      <span className="font-mono text-xs font-bold text-cockpit-text">
                        {agent.name}
                      </span>
                    </div>
                    <span className={`text-[10px] font-mono uppercase ${statusColor}`}>
                      {agent.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[10px] font-mono mb-2">
                    <div>
                      <div className="text-cockpit-muted">published</div>
                      <div className="text-cockpit-text font-bold">{agent.stats?.totalPublished ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-cockpit-muted">alerts</div>
                      <div className={`font-bold ${agent.stats?.alertCount ? "text-cockpit-alert" : "text-cockpit-text"}`}>
                        {agent.stats?.alertCount ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="text-cockpit-muted">embedded</div>
                      <div className="text-cockpit-text font-bold">{agent.stats?.totalEmbedded ?? 0}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[9px] font-mono text-cockpit-muted">
                    <span className="bg-cockpit-card px-1.5 py-0.5 rounded">
                      {agent.channels} tg channels
                    </span>
                    {agent.externalSources > 0 && (
                      <span className="bg-cockpit-card px-1.5 py-0.5 rounded">
                        {agent.externalSources} ext sources
                      </span>
                    )}
                    <span className="bg-cockpit-card px-1.5 py-0.5 rounded">
                      up {uptimeStr}
                    </span>
                    <span className="bg-cockpit-card px-1.5 py-0.5 rounded" title={agent.host}>
                      {agent.host.slice(0, 16)}
                    </span>
                  </div>
                  <div className="text-[9px] font-mono text-cockpit-muted/50 mt-1.5">
                    heartbeat {relativeTime(agent.lastHeartbeat)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* === ACTIVE STORIES === */}
      {stories.length > 0 && (
        <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-4 mb-6">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-3">
            Active Stories — {stories.length} cluster{stories.length !== 1 ? "s" : ""}
          </h2>
          <div className="space-y-2">
            {stories.slice(0, 10).map((story) => (
              <div
                key={story.id}
                className={`flex items-start gap-3 p-3 rounded border ${
                  story.hasAlert
                    ? "bg-cockpit-alert/5 border-cockpit-alert/20"
                    : "bg-cockpit-bg border-cockpit-border/50"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {story.hasAlert && (
                      <span className="text-[9px] font-mono bg-cockpit-alert/20 text-cockpit-alert px-1.5 py-0.5 rounded uppercase">
                        ALERT
                      </span>
                    )}
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                        TOPIC_COLORS[story.topic] || "bg-cockpit-card text-cockpit-muted"
                      }`}
                    >
                      {story.topic}
                    </span>
                    <span className="text-[9px] font-mono text-cockpit-muted">
                      {relativeTime(story.lastSeen)}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-cockpit-text leading-snug mb-1.5 truncate">
                    {story.title}
                  </div>
                  <div className="flex items-center gap-3 text-[9px] font-mono text-cockpit-muted">
                    <span className="text-cockpit-accent font-bold">{story.postCount} posts</span>
                    <span>{story.channels.length} source{story.channels.length !== 1 ? "s" : ""}</span>
                    <span className="truncate" title={story.channels.join(", ")}>
                      {story.channels.slice(0, 3).join(", ")}
                      {story.channels.length > 3 ? ` +${story.channels.length - 3}` : ""}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === IDENTITY RESOLUTION === */}
      <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-4 mb-6">
        <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-3">
          Identity Resolution
        </h2>

        <form onSubmit={handleIdentitySearch} className="flex gap-2 mb-3">
          {/* Mode selector */}
          <div className="flex border border-cockpit-border rounded overflow-hidden">
            {(["address", "twitter", "telegram", "github", "discord"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => { setIdentityMode(mode); setIdentityResult(null); }}
                className={`px-2 py-1.5 text-[10px] font-mono uppercase transition ${
                  identityMode === mode
                    ? "bg-cockpit-accent text-white"
                    : "bg-cockpit-bg text-cockpit-muted hover:text-cockpit-text"
                }`}
              >
                {mode === "address" ? "addr" : mode}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={identityQuery}
            onChange={(e) => setIdentityQuery(e.target.value)}
            placeholder={
              identityMode === "address" ? "Agent address (0x...)" :
              `${identityMode} handle...`
            }
            className="flex-1 bg-cockpit-bg border border-cockpit-border rounded px-3 py-1.5 text-xs font-mono text-cockpit-text placeholder:text-cockpit-muted/50 focus:outline-none focus:border-cockpit-accent"
          />
          <button
            type="submit"
            disabled={identityLoading || !identityQuery.trim()}
            className="px-3 py-1.5 bg-cockpit-accent/20 border border-cockpit-accent/50 rounded text-[10px] font-mono text-cockpit-accent hover:bg-cockpit-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {identityLoading ? "..." : "Resolve"}
          </button>
          {status?.wallet && identityMode === "address" && (
            <button
              type="button"
              onClick={() => setIdentityQuery(status.wallet!)}
              className="px-2 py-1.5 text-[10px] font-mono text-cockpit-muted border border-cockpit-border rounded hover:text-cockpit-text transition"
              title="Use geoscope agent address"
            >
              self
            </button>
          )}
        </form>

        {/* Results */}
        {identityResult && (
          <div className="bg-cockpit-bg rounded p-3">
            {identityResult.error && (
              <div className="text-xs font-mono text-cockpit-alert">{identityResult.error}</div>
            )}

            {/* Address resolution results */}
            {identityResult.address && !identityResult.error && (
              <div className="space-y-2">
                <div className="text-[10px] font-mono text-cockpit-muted">
                  {identityResult.address.slice(0, 12)}...{identityResult.address.slice(-8)}
                </div>

                {/* Web2 linked accounts */}
                {identityResult.web2 && Object.keys(identityResult.web2).length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-mono text-cockpit-accent uppercase tracking-wider">Linked Accounts</div>
                    {Object.entries(identityResult.web2).map(([platform, data]) => (
                      <div key={platform} className="flex items-center gap-2 px-2 py-1.5 bg-cockpit-card rounded border border-cockpit-border/50">
                        <span className="text-xs font-mono font-bold text-cockpit-text uppercase">{platform}</span>
                        <span className="text-xs font-mono text-cockpit-muted">
                          {typeof data === "string" ? data : JSON.stringify(data)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs font-mono text-cockpit-muted">No web2 accounts linked</div>
                )}

                {/* Cross-chain wallets */}
                {identityResult.xm && Object.keys(identityResult.xm).length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-mono text-cockpit-accent uppercase tracking-wider">Cross-Chain Wallets</div>
                    {Object.entries(identityResult.xm).map(([chain, data]) => (
                      <div key={chain} className="flex items-center gap-2 px-2 py-1.5 bg-cockpit-card rounded border border-cockpit-border/50">
                        <span className="text-xs font-mono font-bold text-cockpit-text uppercase">{chain}</span>
                        <span className="text-xs font-mono text-cockpit-muted break-all">
                          {typeof data === "string" ? data : JSON.stringify(data)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* PQC keys */}
                {identityResult.pqc && Object.keys(identityResult.pqc).length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-mono text-cockpit-accent uppercase tracking-wider">Post-Quantum Keys</div>
                    {Object.entries(identityResult.pqc).map(([algo, data]) => (
                      <div key={algo} className="flex items-center gap-2 px-2 py-1.5 bg-cockpit-card rounded border border-cockpit-border/50">
                        <span className="text-xs font-mono font-bold text-cockpit-text">{algo}</span>
                        <span className="text-[10px] font-mono text-cockpit-observation">bound</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Unstoppable Domains */}
                {identityResult.ud && identityResult.ud.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-mono text-cockpit-accent uppercase tracking-wider">Domains</div>
                    {identityResult.ud.map((domain, i) => (
                      <div key={i} className="text-xs font-mono text-cockpit-text px-2 py-1.5 bg-cockpit-card rounded border border-cockpit-border/50">
                        {String(domain)}
                      </div>
                    ))}
                  </div>
                )}

                {!identityResult.hasLinks && (
                  <div className="text-xs font-mono text-cockpit-muted/60 mt-1">
                    This address has no linked identities yet
                  </div>
                )}
              </div>
            )}

            {/* Reverse lookup results */}
            {identityResult.platform && !identityResult.error && (
              <div className="space-y-2">
                <div className="text-[10px] font-mono text-cockpit-muted">
                  {identityResult.platform}: @{identityResult.handle}
                </div>
                {identityResult.addresses && identityResult.addresses.length > 0 ? (
                  <div className="space-y-1">
                    {identityResult.addresses.map((addr, i) => (
                      <div
                        key={i}
                        className="text-xs font-mono text-cockpit-text px-2 py-1.5 bg-cockpit-card rounded border border-cockpit-border/50 cursor-pointer hover:border-cockpit-accent/50 transition"
                        onClick={() => { setIdentityMode("address"); setIdentityQuery(String(addr)); setIdentityResult(null); }}
                        title="Click to resolve this address"
                      >
                        {String(addr)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs font-mono text-cockpit-muted">
                    No Demos addresses linked to this {identityResult.platform} handle
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

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

      {/* === CLAUDE ANALYSIS PANEL === */}
      <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5 mb-6">
        <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted mb-4">
          Claude Analysis
        </h2>
        <form onSubmit={handleAnalyze} className="flex gap-2 mb-3">
          <textarea
            value={analysisPrompt}
            onChange={(e) => setAnalysisPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleAnalyze(e);
              }
            }}
            placeholder="Ask Claude to analyze intelligence data... (Cmd+Enter to submit)"
            rows={2}
            className="flex-1 bg-cockpit-bg border border-cockpit-border rounded px-3 py-2 text-sm font-mono text-cockpit-text placeholder:text-cockpit-muted/50 focus:outline-none focus:border-cockpit-accent resize-y"
          />
          <div className="flex flex-col gap-2 self-end">
            {availableModels.length > 0 && (
              <select
                value={analysisModel}
                onChange={(e) => setAnalysisModel(e.target.value)}
                disabled={analysisLoading}
                className="bg-cockpit-bg border border-cockpit-border rounded px-2 py-1.5 text-[11px] font-mono text-cockpit-text focus:outline-none focus:border-cockpit-accent disabled:opacity-40 cursor-pointer"
              >
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
            <button
              type="submit"
              disabled={analysisLoading || !analysisPrompt.trim()}
              className="px-4 py-2 bg-cockpit-accent/20 border border-cockpit-accent/50 rounded text-xs font-mono text-cockpit-accent hover:bg-cockpit-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {analysisLoading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
        </form>
        {analysisError && (
          <div className="text-xs font-mono text-cockpit-alert mb-2">{analysisError}</div>
        )}
        {analysisStatus && (
          <div className="text-xs font-mono text-cockpit-accent mb-2 animate-pulse">
            {analysisStatus}
          </div>
        )}
        {analysisQueries.length > 0 && (
          <div className="mb-3">
            <button
              onClick={() => setShowQueries(!showQueries)}
              className="text-[11px] font-mono text-cockpit-muted hover:text-cockpit-accent transition"
            >
              {showQueries ? "Hide" : "Show"} search queries ({analysisQueries.length})
            </button>
            {showQueries && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {analysisQueries.map((q, i) => (
                  <span key={i} className="px-2 py-0.5 bg-cockpit-bg border border-cockpit-border rounded text-[10px] font-mono text-cockpit-text/70">
                    {q}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {(analysisResponse || (analysisLoading && analysisSources.length > 0)) && (
          <div className="bg-cockpit-bg rounded p-4 mb-3 max-h-[500px] overflow-y-auto">
            {analysisLoading && !analysisResponse && (
              <div className="text-xs font-mono text-cockpit-muted animate-pulse">
                Analyzing {analysisSources.length} sources...
              </div>
            )}
            <div className="text-sm text-cockpit-text/90 leading-relaxed whitespace-pre-wrap font-mono">
              {analysisResponse}
              {analysisLoading && (
                <span className="inline-block w-1.5 h-4 bg-cockpit-accent/70 animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          </div>
        )}
        {analysisSources.length > 0 && (
          <div>
            <button
              onClick={() => setShowSources(!showSources)}
              className="text-[11px] font-mono text-cockpit-muted hover:text-cockpit-accent transition"
            >
              {showSources ? "Hide" : "Show"} context used ({analysisSources.length} sources)
            </button>
            {showSources && (
              <div className="mt-2 space-y-1.5 pl-3 border-l border-cockpit-accent/30">
                {analysisSources.map((s, i) => (
                  <div key={i} className="text-[11px] font-mono">
                    <div className="flex items-center gap-2">
                      <span className="text-cockpit-muted">@{s.channel}</span>
                      <span
                        className={`px-1 py-0.5 rounded text-[9px] ${
                          TOPIC_COLORS[s.topic] || "bg-cockpit-border text-cockpit-muted"
                        }`}
                      >
                        {s.topic}
                      </span>
                      <span className="text-cockpit-accent ml-auto">
                        {(s.similarity * 100).toFixed(1)}%
                      </span>
                      <span className="text-cockpit-muted">
                        {s.timestamp ? relativeTime(s.timestamp) : ""}
                      </span>
                    </div>
                    <p className="text-cockpit-text/50 leading-relaxed">{s.textPreview}...</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* === SUPERCOLONY CHAIN FEED === */}
      <div className="bg-cockpit-card border border-cockpit-border rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-xs tracking-widest uppercase text-cockpit-muted">
            SuperColony Chain Feed
          </h2>
          {chainStats && (
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-cockpit-accent">
                {chainStats.totalPosts.toLocaleString()} posts
              </span>
              {chainStats.lastIngested && (
                <span className="text-[10px] font-mono text-cockpit-muted">
                  last: {relativeTime(chainStats.lastIngested)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Category stats chips */}
        {chainStats && Object.keys(chainStats.categories).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {Object.entries(chainStats.categories)
              .sort(([, a], [, b]) => b - a)
              .map(([cat, count]) => (
                <span
                  key={cat}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                    TOPIC_COLORS[cat] || "bg-cockpit-border text-cockpit-muted"
                  }`}
                >
                  {cat} {count}
                </span>
              ))}
          </div>
        )}

        {/* Category filter buttons */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {["", "observation", "analysis", "prediction", "alert", "action", "signal"].map((cat) => (
            <button
              key={cat}
              onClick={() => setChainFilter(cat)}
              className={`px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider transition ${
                chainFilter === cat
                  ? "bg-cockpit-accent text-white"
                  : "bg-cockpit-bg border border-cockpit-border text-cockpit-muted hover:text-cockpit-text"
              }`}
            >
              {cat || "all"}
            </button>
          ))}
        </div>

        {/* Post list */}
        <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
          {chainFeed.length === 0 && (
            <div className="text-xs text-cockpit-muted font-mono">
              No chain posts yet — run the chain poller to ingest
            </div>
          )}
          {chainFeed.map((post, i) => (
            <div key={`${post.messageId}-${i}`} className="border-b border-cockpit-border/50 pb-2 last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                    TOPIC_COLORS[post.topic] || "bg-cockpit-border text-cockpit-muted"
                  }`}
                >
                  {post.topic}
                </span>
                <span className="text-[10px] font-mono text-cockpit-muted" title={post.author}>
                  {post.author.slice(0, 8)}...{post.author.slice(-4)}
                </span>
                <span className="text-[10px] font-mono text-cockpit-muted ml-auto">
                  {post.timestamp ? relativeTime(post.timestamp) : ""}
                </span>
                <button
                  onClick={() => fetchChainRelated(i, post.text)}
                  disabled={chainRelatedLoading[i]}
                  className="text-[10px] font-mono text-cockpit-accent hover:text-cockpit-text transition disabled:opacity-40"
                >
                  {chainRelatedLoading[i] ? "..." : chainRelatedMap[i] ? "hide" : "related"}
                </button>
              </div>
              <p className="text-xs text-cockpit-text/80 leading-relaxed">
                {post.text.length > 200 ? post.text.slice(0, 200) + "..." : post.text}
              </p>
              {chainRelatedMap[i] && chainRelatedMap[i].length > 0 && (
                <div className="mt-2 ml-3 space-y-1.5 border-l-2 border-cockpit-accent/30 pl-3">
                  {chainRelatedMap[i].map((r, j) => (
                    <div key={j} className="text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-cockpit-muted">
                          {r.channel.startsWith("sc:") ? r.channel.slice(3, 11) + "..." : "@" + r.channel}
                        </span>
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
              {chainRelatedMap[i] && chainRelatedMap[i].length === 0 && (
                <div className="mt-1 ml-3 text-[10px] font-mono text-cockpit-muted">
                  No related messages found
                </div>
              )}
            </div>
          ))}
        </div>
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
            {data.totalProcessed.toLocaleString()} scanned
          </span>
          <span className="text-[10px] font-mono text-cockpit-accent">
            {data.totalEmbedded.toLocaleString()} embedded
          </span>
          <span className="text-[10px] font-mono text-cockpit-analysis">
            {data.totalFullPipeline} published
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

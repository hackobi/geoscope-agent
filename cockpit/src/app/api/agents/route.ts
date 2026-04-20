// Agent Mesh API — register agents and receive heartbeats
// Any agent (local or remote) can POST here to announce itself.
// GET returns the list of all known agents and their last status.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GEOSCOPE_ROOT = process.env.GEOSCOPE_ROOT || path.resolve(process.cwd(), "..");
const AGENTS_FILE = path.join(GEOSCOPE_ROOT, "data/agents.json");
const AGENT_STALE_MS = 5 * 60 * 1000; // 5 minutes without heartbeat = stale

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────

interface AgentRecord {
  agentId: string;
  name: string;
  type: string;           // "geoscope" | "custom" | ...
  host: string;
  status: "running" | "stale" | "offline";
  uptimeMs: number;
  channels: number;
  externalSources: number;
  stats: {
    totalPublished: number;
    totalEmbedded: number;
    alertCount: number;
  };
  lastActivity: number;
  lastHeartbeat: number;
  registeredAt: number;
}

interface AgentsStore {
  agents: AgentRecord[];
}

// ── Persistence ───────────────────────────────────────────────

function loadAgents(): AgentsStore {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      return JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return { agents: [] };
}

function saveAgents(store: AgentsStore) {
  try {
    const dir = path.dirname(AGENTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(store, null, 2));
  } catch { /* ignore */ }
}

function markStaleAgents(agents: AgentRecord[]): AgentRecord[] {
  const now = Date.now();
  return agents.map((a) => ({
    ...a,
    status: now - a.lastHeartbeat > AGENT_STALE_MS ? "stale" : a.status,
  }));
}

// ── GET — list all agents ─────────────────────────────────────

export async function GET() {
  const store = loadAgents();
  const agents = markStaleAgents(store.agents);
  return NextResponse.json({ agents });
}

// ── POST — register or update (heartbeat) ────────────────────

export async function POST(request: NextRequest) {
  let body: Partial<AgentRecord>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { agentId, name, type, host } = body;
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const store = loadAgents();
  const now = Date.now();

  const existing = store.agents.find((a) => a.agentId === agentId);
  if (existing) {
    // Update in place
    Object.assign(existing, {
      name: name || existing.name,
      type: type || existing.type,
      host: host || existing.host,
      status: "running",
      uptimeMs: body.uptimeMs ?? existing.uptimeMs,
      channels: body.channels ?? existing.channels,
      externalSources: body.externalSources ?? existing.externalSources,
      stats: body.stats ?? existing.stats,
      lastActivity: body.lastActivity ?? now,
      lastHeartbeat: now,
    });
  } else {
    // New registration
    store.agents.push({
      agentId,
      name: name || agentId,
      type: type || "unknown",
      host: host || "unknown",
      status: "running",
      uptimeMs: body.uptimeMs ?? 0,
      channels: body.channels ?? 0,
      externalSources: body.externalSources ?? 0,
      stats: body.stats ?? { totalPublished: 0, totalEmbedded: 0, alertCount: 0 },
      lastActivity: body.lastActivity ?? now,
      lastHeartbeat: now,
      registeredAt: now,
    });
  }

  // Cap at 50 agents
  if (store.agents.length > 50) {
    store.agents = store.agents.slice(-50);
  }

  saveAgents(store);
  return NextResponse.json({ ok: true, agentId });
}

// Geoscope Embeddings API — HTTP interface for remote LanceDB queries
// Usage: npx tsx --env-file=.env src/api.mjs
// Port: 7600 (override with API_PORT env var)

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { LANCEDB_PATH } from "./config.mjs";
import { embed, isAvailable as embeddingsAvailable } from "./embeddings/embedder.mjs";

const PORT = parseInt(process.env.API_PORT || "7600", 10);
const API_KEY = process.env.GEOSCOPE_API_KEY || "";
const app = express();

let db, table;

async function initDB() {
  const lancedb = await import("@lancedb/lancedb");
  db = await lancedb.connect(LANCEDB_PATH);
  const tables = await db.tableNames();
  if (!tables.includes("posts")) {
    throw new Error("LanceDB 'posts' table not found — has Geoscope run yet?");
  }
  table = await db.openTable("posts");
  const count = await table.countRows();
  console.log(`LanceDB ready: ${count} rows in 'posts'`);
}

// CORS — allow any machine on the network
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// JSON body parsing
app.use(express.json());

// API key auth — skip /health
app.use((req, res, next) => {
  if (!API_KEY) return next(); // no key configured = open access
  if (req.path === "/health") return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized — provide Authorization: Bearer <key>" });
  }
  next();
});

// --- /search?q=<text>&limit=10&topic=<optional> ---
app.get("/search", async (req, res) => {
  const q = req.query.q;
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
  const topic = req.query.topic || null;

  if (!q) return res.status(400).json({ error: "q parameter required" });
  if (!embeddingsAvailable()) return res.status(503).json({ error: "OpenAI API key not configured" });

  try {
    const vector = await embed(q);
    if (!vector) return res.status(500).json({ error: "Embedding failed" });

    let query = table.search(vector).limit(limit * 3); // overfetch to filter
    const raw = await query.toArray();

    let results = raw.map((r) => ({
      channel: r.channel,
      topic: r.topic,
      messageId: r.messageId,
      text: r.text,
      timestamp: r.timestamp,
      similarity: r._distance !== undefined ? +(1 - r._distance).toFixed(4) : null,
    }));

    if (topic) {
      results = results.filter((r) => r.topic === topic);
    }

    res.json({ query: q, count: results.slice(0, limit).length, results: results.slice(0, limit) });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- /trends?topic=<topic>&hours=24&limit=20 ---
app.get("/trends", async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || "24", 10), 168); // max 7 days
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const topic = req.query.topic || null;

  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  try {
    // Query with timestamp filter
    let query = table.query().where(`timestamp >= ${cutoff}`);
    if (topic) {
      query = query.where(`topic = '${topic.replace(/'/g, "")}'`);
    }
    const rows = await query.limit(limit * 5).toArray(); // overfetch, then sort+trim

    // Sort by timestamp descending
    rows.sort((a, b) => b.timestamp - a.timestamp);

    const results = rows.slice(0, limit).map((r) => ({
      channel: r.channel,
      topic: r.topic,
      messageId: r.messageId,
      text: r.text,
      timestamp: r.timestamp,
    }));

    res.json({
      topic: topic || "all",
      hours,
      cutoff: new Date(cutoff).toISOString(),
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("Trends error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- /cross-ref?text=<text>&threshold=0.65 ---
app.get("/cross-ref", async (req, res) => {
  const text = req.query.text;
  const threshold = parseFloat(req.query.threshold || "0.65");
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

  if (!text) return res.status(400).json({ error: "text parameter required" });
  if (!embeddingsAvailable()) return res.status(503).json({ error: "OpenAI API key not configured" });

  try {
    const vector = await embed(text);
    if (!vector) return res.status(500).json({ error: "Embedding failed" });

    const raw = await table.search(vector).limit(limit * 2).toArray();

    const matches = raw
      .map((r) => ({
        channel: r.channel,
        topic: r.topic,
        messageId: r.messageId,
        text: r.text,
        timestamp: r.timestamp,
        similarity: r._distance !== undefined ? +(1 - r._distance).toFixed(4) : null,
      }))
      .filter((r) => r.similarity !== null && r.similarity >= threshold)
      .slice(0, limit);

    res.json({
      threshold,
      duplicateRisk: matches.length > 0,
      count: matches.length,
      results: matches,
    });
  } catch (err) {
    console.error("Cross-ref error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- /recent?limit=20&channel=<optional> ---
app.get("/recent", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const channel = req.query.channel || null;

  try {
    let query = table.query();
    if (channel) {
      query = query.where(`channel = '${channel.replace(/'/g, "")}'`);
    }
    const rows = await query.limit(limit * 3).toArray();

    rows.sort((a, b) => b.timestamp - a.timestamp);

    const results = rows.slice(0, limit).map((r) => ({
      channel: r.channel,
      topic: r.topic,
      messageId: r.messageId,
      text: r.text,
      timestamp: r.timestamp,
    }));

    res.json({ count: results.length, results });
  } catch (err) {
    console.error("Recent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- /stats ---
app.get("/stats", async (req, res) => {
  try {
    const count = await table.countRows();

    const sample = await table.query().limit(10000).toArray();
    const channels = {};
    const topics = {};
    let latestTimestamp = 0;
    for (const row of sample) {
      channels[row.channel] = (channels[row.channel] || 0) + 1;
      topics[row.topic] = (topics[row.topic] || 0) + 1;
      if (row.timestamp > latestTimestamp) latestTimestamp = row.timestamp;
    }

    res.json({
      totalRows: count,
      channels,
      topics,
      latestEntry: latestTimestamp ? new Date(latestTimestamp).toISOString() : null,
      embeddingModel: "text-embedding-3-small",
      dimensions: 1536,
    });
  } catch (err) {
    console.error("Stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- /health ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- POST /optimize — compact + prune old versions ---
app.post("/optimize", async (_req, res) => {
  try {
    const version = await table.version();
    const count = await table.countRows();
    console.log(`[Optimize] Starting — version ${version}, ${count} rows`);

    const stats = await table.optimize({
      cleanupOlderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });

    const newVersion = await table.version();
    console.log(`[Optimize] Done — version ${newVersion}`);

    res.json({
      ok: true,
      before: { version, rows: count },
      after: { version: newVersion },
      compaction: stats.compaction,
      prune: stats.prune,
    });
  } catch (err) {
    console.error("Optimize error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// /analyze — Multi-search + LLM analysis pipeline
// ═══════════════════════════════════════════════════════════════

const MODELS = {
  "claude-sonnet": {
    id: "claude-sonnet",
    label: "Claude Sonnet 4",
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  },
  "minimax-2.7": {
    id: "minimax-2.7",
    label: "MiniMax 2.7",
    provider: "minimax",
    modelId: "MiniMax-Text-01",
  },
};

const DEFAULT_MODEL = "minimax-2.7";

let anthropicClient = null;

function getAnthropic() {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

async function generateSearchQueries(prompt) {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: `You are a search query generator for a geopolitical intelligence database containing news messages from Telegram channels. Given a user's analytical question, generate 5-8 diverse, concrete search queries that will retrieve relevant data via vector similarity search.

Rules:
- Each query should target a different angle, region, actor, or theme related to the question
- Use concrete language that matches how news/intelligence is written (country names, leader names, specific topics like "sanctions", "military cooperation", "trade agreement")
- Avoid abstract/analytical language — the database contains raw news, not analysis
- Cover different geopolitical regions and actors when the question is broad
- Return ONLY a JSON array of strings, nothing else`,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const queries = JSON.parse(jsonMatch[0]);
      if (Array.isArray(queries) && queries.every((q) => typeof q === "string")) {
        return queries;
      }
    }
  } catch {
    // Fall through
  }
  return [prompt];
}

async function multiSearch(queries, perQuery = 8) {
  if (!embeddingsAvailable()) throw new Error("OpenAI API key not configured for embeddings");

  const allResults = await Promise.all(
    queries.map(async (q) => {
      const vector = await embed(q);
      if (!vector) return [];
      const raw = await table.search(vector).limit(perQuery).toArray();
      return raw.map((r) => ({
        channel: r.channel,
        topic: r.topic,
        messageId: r.messageId,
        text: r.text,
        timestamp: r.timestamp,
        similarity: r._distance !== undefined ? +(1 - r._distance).toFixed(4) : null,
      }));
    })
  );

  const seen = new Map();
  for (const results of allResults) {
    for (const r of results) {
      const key = `${r.channel}:${r.messageId}`;
      const existing = seen.get(key);
      if (!existing || r.similarity > existing.similarity) {
        seen.set(key, r);
      }
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 30);
}

function buildContextBlock(results) {
  if (results.length === 0) return "No relevant intelligence data found.";

  return results
    .map((r, i) => {
      const date = r.timestamp
        ? new Date(r.timestamp).toISOString().slice(0, 16)
        : "unknown";
      return `[${i + 1}] @${r.channel} (${r.topic}) — ${date} — similarity: ${((r.similarity || 0) * 100).toFixed(1)}%\n${r.text}`;
    })
    .join("\n\n---\n\n");
}

function buildSystemPrompt(embeddings, extraContext) {
  const contextBlock = buildContextBlock(embeddings);
  return `You are a senior intelligence analyst for the Geoscope monitoring system. You analyze geopolitical intelligence gathered from ${embeddings.length} messages across multiple Telegram channels.

Below is intelligence data retrieved from your embedded database using multiple targeted search queries:

${contextBlock}

${extraContext ? `Additional context provided by the analyst:\n${extraContext}\n` : ""}Instructions:
- Synthesize the data above to answer the user's question with depth and nuance.
- Reference specific sources using [1], [2], etc. notation.
- Identify patterns, connections, and contradictions across different channels and regions.
- Distinguish between confirmed reports and unverified claims.
- When making predictions or assessments, state your confidence level and reasoning.
- Use a professional intelligence briefing tone.
- If key data is missing, note the gap but still analyze what's available.`;
}

async function* streamAnthropic(systemPrompt, prompt) {
  const client = getAnthropic();
  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

async function* streamMiniMax(systemPrompt, prompt, modelId) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY not set");

  const res = await fetch("https://api.minimaxi.chat/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: 4096,
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`MiniMax API error: ${res.status} ${err}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response stream from MiniMax");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // skip malformed chunks
      }
    }
  }
}

// Collect full text from async generator
async function collectStream(gen) {
  let text = "";
  for await (const chunk of gen) {
    text += chunk;
  }
  return text;
}

// GET /analyze — list available models
app.get("/analyze", (_req, res) => {
  const models = Object.values(MODELS).map((m) => ({ id: m.id, label: m.label }));
  res.json({ models, default: DEFAULT_MODEL });
});

// POST /analyze — multi-search + LLM analysis
// ?stream=false → JSON response (default for agents)
// ?stream=true  → SSE stream (same format as cockpit)
app.post("/analyze", async (req, res) => {
  const { prompt, context: extraContext, model: modelId } = req.body;

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'prompt' parameter" });
  }

  const selectedModel = MODELS[modelId] || MODELS[DEFAULT_MODEL];
  const wantStream = req.query.stream === "true";

  try {
    // Phase 1: Generate search queries
    const queries = await generateSearchQueries(prompt);

    // Phase 2: Multi-search
    const embeddings = await multiSearch(queries);

    const sources = embeddings.map((r) => ({
      channel: r.channel,
      topic: r.topic,
      similarity: r.similarity,
      timestamp: r.timestamp,
      textPreview: r.text.slice(0, 120),
    }));

    // Phase 3: Analysis
    const systemPrompt = buildSystemPrompt(embeddings, extraContext);

    const stream =
      selectedModel.provider === "minimax"
        ? streamMiniMax(systemPrompt, prompt, selectedModel.modelId)
        : streamAnthropic(systemPrompt, prompt);

    if (!wantStream) {
      // JSON mode — collect full response
      const analysis = await collectStream(stream);
      return res.json({
        analysis,
        sources,
        queries,
        model: selectedModel.id,
      });
    }

    // SSE mode
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    res.write(`data: ${JSON.stringify({ type: "queries", queries })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "context", sources })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "status", message: `Analyzing with ${selectedModel.label}...` })}\n\n`);

    for await (const text of stream) {
      res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Analyze error:", err.message);
    if (wantStream && res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// --- Start ---
async function main() {
  await initDB();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Geoscope API listening on http://0.0.0.0:${PORT}`);
    console.log(`Auth: ${API_KEY ? "enabled (Bearer token required)" : "disabled (no GEOSCOPE_API_KEY set)"}`);
    console.log(`Endpoints:`);
    console.log(`  GET  /search?q=<text>&limit=10&topic=<optional>`);
    console.log(`  GET  /trends?topic=<topic>&hours=24&limit=20`);
    console.log(`  GET  /cross-ref?text=<text>&threshold=0.65`);
    console.log(`  GET  /recent?limit=20&channel=<optional>`);
    console.log(`  GET  /stats`);
    console.log(`  GET  /health`);
    console.log(`  GET  /analyze — list models`);
    console.log(`  POST /analyze — multi-search + LLM analysis (?stream=true for SSE)`);
    console.log(`  POST /optimize — compact + prune old LanceDB versions`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

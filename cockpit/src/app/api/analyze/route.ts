import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { searchEmbeddings, EmbeddingSearchResult } from "@/lib/vector-search";

export const dynamic = "force-dynamic";

// --- Model registry ---

interface ModelConfig {
  id: string;
  label: string;
  provider: "anthropic" | "minimax";
  modelId: string;
}

const MODELS: Record<string, ModelConfig> = {
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

// --- Clients ---

let anthropicClient: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// --- Query generation (always uses Claude — fast, cheap) ---

async function generateSearchQueries(prompt: string): Promise<string[]> {
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
      if (Array.isArray(queries) && queries.every((q: unknown) => typeof q === "string")) {
        return queries;
      }
    }
  } catch {
    // Fall through
  }
  return [prompt];
}

// --- Multi-search ---

async function multiSearch(
  queries: string[],
  perQuery = 8
): Promise<EmbeddingSearchResult[]> {
  const allResults = await Promise.all(
    queries.map((q) => searchEmbeddings(q, perQuery))
  );

  const seen = new Map<string, EmbeddingSearchResult>();
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

function buildContextBlock(results: EmbeddingSearchResult[]): string {
  if (results.length === 0) return "No relevant intelligence data found.";

  return results
    .map((r, i) => {
      const date = r.timestamp
        ? new Date(r.timestamp).toISOString().slice(0, 16)
        : "unknown";
      return `[${i + 1}] @${r.channel} (${r.topic}) — ${date} — similarity: ${(r.similarity * 100).toFixed(1)}%\n${r.text}`;
    })
    .join("\n\n---\n\n");
}

function buildSystemPrompt(
  embeddings: EmbeddingSearchResult[],
  extraContext?: string
): string {
  const contextBlock = buildContextBlock(embeddings);
  return `You are a senior intelligence analyst for the Geoscope monitoring system. You analyze geopolitical intelligence gathered from ${embeddings.length} messages across multiple Telegram channels.

Below is intelligence data retrieved from your embedded database using multiple targeted search queries:

${contextBlock}

${extraContext ? `Additional context provided by the analyst:\n${extraContext}\n` : ""}
Instructions:
- Synthesize the data above to answer the user's question with depth and nuance.
- Reference specific sources using [1], [2], etc. notation.
- Identify patterns, connections, and contradictions across different channels and regions.
- Distinguish between confirmed reports and unverified claims.
- When making predictions or assessments, state your confidence level and reasoning.
- Use a professional intelligence briefing tone.
- If key data is missing, note the gap but still analyze what's available.`;
}

// --- Streaming: Anthropic ---

async function* streamAnthropic(
  systemPrompt: string,
  prompt: string
): AsyncGenerator<string> {
  const client = getAnthropic();
  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

// --- Streaming: MiniMax (OpenAI-compatible) ---

async function* streamMiniMax(
  systemPrompt: string,
  prompt: string,
  modelId: string
): AsyncGenerator<string> {
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

// --- Route handler ---

export async function GET() {
  const models = Object.values(MODELS).map((m) => ({
    id: m.id,
    label: m.label,
  }));
  return new Response(JSON.stringify({ models, default: DEFAULT_MODEL }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, context: extraContext, model: modelId } = body;

    if (!prompt || typeof prompt !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'prompt' parameter" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const selectedModel = MODELS[modelId] || MODELS[DEFAULT_MODEL];

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // Phase 1: Generate search queries (always Claude)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "status", message: "Generating search queries..." })}\n\n`
            )
          );

          const queries = await generateSearchQueries(prompt);

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "queries", queries })}\n\n`
            )
          );

          // Phase 2: Multi-search
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "status", message: `Searching ${queries.length} queries across embeddings...` })}\n\n`
            )
          );

          const embeddings = await multiSearch(queries);

          const meta = embeddings.map((r) => ({
            channel: r.channel,
            topic: r.topic,
            similarity: r.similarity,
            timestamp: r.timestamp,
            textPreview: r.text.slice(0, 120),
          }));
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "context", sources: meta })}\n\n`
            )
          );

          // Phase 3: Analysis with selected model
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "status", message: `Analyzing with ${selectedModel.label}...` })}\n\n`
            )
          );

          const systemPrompt = buildSystemPrompt(embeddings, extraContext);

          const stream =
            selectedModel.provider === "minimax"
              ? streamMiniMax(systemPrompt, prompt, selectedModel.modelId)
              : streamAnthropic(systemPrompt, prompt);

          for await (const text of stream) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text", text })}\n\n`
              )
            );
          }

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Stream error";
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", error: message })}\n\n`
            )
          );
        }
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Analyze API error:", error);
    const message = error instanceof Error ? error.message : "Analysis failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

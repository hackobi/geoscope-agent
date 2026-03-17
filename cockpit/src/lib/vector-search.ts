import { connect } from "@lancedb/lancedb";
import OpenAI from "openai";
import path from "path";

const GEOSCOPE_ROOT = process.env.GEOSCOPE_ROOT || path.resolve(process.cwd(), "..");

export interface EmbeddingSearchResult {
  channel: string;
  messageId: number;
  text: string;
  timestamp: number;
  topic: string;
  similarity: number;
}

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not set in .env.local");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

async function embedText(text: string): Promise<number[]> {
  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

/**
 * Vector search across all embedded messages
 *
 * NOTE: This requires OPENAI_API_KEY to generate query embeddings.
 * For a free alternative without API costs, see keyword-based search
 * in future releases (regex/substring filtering).
 */
export async function searchEmbeddings(
  text: string,
  limit = 10
): Promise<EmbeddingSearchResult[]> {
  try {
    const dbPath = path.join(GEOSCOPE_ROOT, "data/lancedb");
    const db = await connect(dbPath);
    const table = await db.openTable("posts");
    const queryVector = await embedText(text);

    const results = await table
      .search(queryVector)
      .limit(limit)
      .toArray();

    return results.map((r: unknown) => {
      const row = r as {
        channel: string;
        messageId: number;
        text: string;
        timestamp: number;
        topic: string;
        _distance: number;
      };
      return {
        channel: row.channel,
        messageId: row.messageId,
        text: row.text,
        timestamp: row.timestamp,
        topic: row.topic,
        similarity: 1 / (1 + row._distance),
      };
    });
  } catch (error) {
    console.error("Vector search failed:", error);
    return [];
  }
}

/**
 * Find messages similar to a specific message by channel and messageId
 */
export async function getRelatedMessages(
  channel: string,
  messageId: number,
  limit = 5
): Promise<EmbeddingSearchResult[]> {
  try {
    const dbPath = path.join(GEOSCOPE_ROOT, "data/lancedb");
    const db = await connect(dbPath);
    const table = await db.openTable("posts");

    // Find the target message using LanceDB filter
    const filtered = await table
      .query()
      .where(`channel = '${channel.replace(/'/g, "''")}' AND messageId = ${messageId}`)
      .toArray();
    const target = filtered[0];

    if (!target) {
      return [];
    }

    const targetVec = (target as { vector: number[] }).vector;

    // Search for similar messages
    const results = await table
      .search(targetVec)
      .limit(limit + 1)
      .toArray();

    // Filter out self and map
    return results
      .filter(
        (r: unknown) =>
          !((r as { channel: string; messageId: number }).channel === channel &&
            (r as { channel: string; messageId: number }).messageId === messageId)
      )
      .slice(0, limit)
      .map((r: unknown) => {
        const row = r as {
          channel: string;
          messageId: number;
          text: string;
          timestamp: number;
          topic: string;
          _distance: number;
        };
        return {
          channel: row.channel,
          messageId: row.messageId,
          text: row.text,
          timestamp: row.timestamp,
          topic: row.topic,
          similarity: 1 / (1 + row._distance),
        };
      });
  } catch (error) {
    console.error("Related messages search failed:", error);
    return [];
  }
}

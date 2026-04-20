// LanceDB vector store for post embeddings

import { LANCEDB_PATH } from "../config.mjs";
import { embed } from "./embedder.mjs";

const TABLE_NAME = "posts";
const OPTIMIZE_EVERY_N_WRITES = 500;
const OPTIMIZE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let db;
let table;
let ready = false;
let tableCreating = null; // mutex for first table creation
let writesSinceOptimize = 0;
let optimizing = false;

export async function init() {
  try {
    const lancedb = await import("@lancedb/lancedb");
    db = await lancedb.connect(LANCEDB_PATH);

    // Open existing table or create new one
    const tables = await db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      table = await db.openTable(TABLE_NAME);
    }
    ready = true;
    console.log(`Vector store ready at ${LANCEDB_PATH}`);
  } catch (err) {
    console.warn("LanceDB init failed (embeddings disabled):", err.message);
    ready = false;
  }
}

export function isReady() {
  return ready && db !== undefined;
}

export function needsOptimize() {
  return writesSinceOptimize >= OPTIMIZE_EVERY_N_WRITES;
}

export async function optimize() {
  if (!ready || !table || optimizing) return;
  optimizing = true;
  try {
    console.log("[VectorStore] Running optimize (compact + prune old versions)...");
    const stats = await table.optimize({
      cleanupOlderThan: new Date(Date.now() - OPTIMIZE_RETENTION_MS),
    });
    console.log(`[VectorStore] Compacted: ${JSON.stringify(stats.compaction)}, Pruned: ${JSON.stringify(stats.prune)}`);
    writesSinceOptimize = 0;
  } catch (err) {
    console.warn("[VectorStore] Optimize failed:", err.message);
  } finally {
    optimizing = false;
  }
}

export async function store(record) {
  if (!ready) return;

  try {
    const vector = await embed(record.text);
    if (!vector) return;

    const row = {
      vector,
      channel: record.channel,
      topic: record.topic,
      messageId: record.messageId,
      text: record.text.slice(0, 500),
      timestamp: record.timestamp || Date.now(),
    };

    if (!table) {
      // Serialize first table creation to avoid race condition
      if (!tableCreating) {
        tableCreating = (async () => {
          const t = await db.createTable(TABLE_NAME, [row]);
          table = t;
          return t;
        })();
        try {
          await tableCreating;
        } finally {
          tableCreating = null;
        }
      } else {
        // Wait for in-flight table creation, then add row
        await tableCreating;
        if (table) {
          await table.add([row]);
        } else {
          console.warn("Vector store table creation failed, cannot insert row");
        }
      }
    } else {
      await table.add([row]);
    }

    writesSinceOptimize++;
  } catch (err) {
    console.warn("Vector store insert failed:", err.message);
  }
}

export async function search(text, limit = 5) {
  if (!ready || !table) return [];

  try {
    const vector = await embed(text);
    if (!vector) return [];

    const searchPromise = table.search(vector).limit(limit).toArray();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Vector search timed out (10s)")), 10000)
    );
    const results = await Promise.race([searchPromise, timeoutPromise]);
    return results;
  } catch (err) {
    console.warn("Vector search failed:", err.message);
    return [];
  }
}

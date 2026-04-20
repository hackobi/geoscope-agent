// Chain poller — fetches SuperColony posts from Demos blockchain Explorer API,
// decodes HIVE posts, and embeds them into the shared LanceDB vector store.

import { readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import { decodeHivePost } from "./decoder.mjs";
import { fetchTransactions, extractStorageTx } from "./explorer-client.mjs";
import { init as initVectorStore, store, isReady, needsOptimize, optimize } from "../embeddings/store.mjs";

const STATE_FILE = resolve("./data/chain-poller-state.json");
const SKIP_CATEGORIES = new Set(["VOTE", "QUESTION"]);
const MAX_PAGES_PER_TICK = 10;
const MAX_BOOTSTRAP_TXS = 2000;
const PAGE_THROTTLE_MS = 300;

let polling = false;
let state = { lastTxHash: null };

function loadState() {
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    state = { lastTxHash: null };
  }
}

function saveState() {
  try {
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.warn("[ChainPoller] Failed to save state:", err.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Map a decoded chain post to the LanceDB record schema.
 */
function toRecord(post, author, txHash, timestamp) {
  return {
    channel: "sc:" + author.slice(0, 12),
    topic: post.cat.toLowerCase(),
    messageId: parseInt(txHash.slice(2, 10), 16),
    text: post.text,
    timestamp: timestamp ? Date.parse(timestamp) : Date.now(),
  };
}

/**
 * Run a single poll cycle: fetch new transactions since lastTxHash.
 */
async function pollOnce() {
  if (polling) return;
  polling = true;

  try {
    const isBootstrap = !state.lastTxHash;
    const maxPages = isBootstrap ? Math.ceil(MAX_BOOTSTRAP_TXS / 50) : MAX_PAGES_PER_TICK;
    const posts = [];
    let cursor = null;
    let totalScanned = 0;
    let hitKnown = false;

    for (let page = 0; page < maxPages; page++) {
      const { data, pagination } = await fetchTransactions(50, cursor);
      if (!data.length) break;

      for (const tx of data) {
        const storage = extractStorageTx(tx);
        if (!storage) continue;

        // Stop if we hit a post we already processed
        if (state.lastTxHash && tx.hash === state.lastTxHash) {
          hitKnown = true;
          break;
        }

        const decoded = decodeHivePost(storage.base64);
        if (!decoded) continue;
        if (SKIP_CATEGORIES.has(decoded.cat)) continue;

        posts.push({
          post: decoded,
          author: storage.author,
          txHash: tx.hash,
          timestamp: storage.timestamp,
        });
      }

      totalScanned += data.length;
      if (hitKnown || !pagination.hasMore) break;
      cursor = pagination.nextCursor;
      await sleep(PAGE_THROTTLE_MS);
    }

    if (posts.length === 0) {
      if (isBootstrap) {
        console.log("[ChainPoller] Bootstrap complete — no HIVE posts found");
      }
      return;
    }

    // Process in chronological order (API returns newest-first)
    posts.reverse();

    const label = isBootstrap ? "Bootstrap" : "Poll";
    console.log(`[ChainPoller] ${label}: ${posts.length} new posts (scanned ${totalScanned} txs)`);

    let embedded = 0;
    for (const { post, author, txHash, timestamp } of posts) {
      const record = toRecord(post, author, txHash, timestamp);
      await store(record);
      embedded++;
    }

    console.log(`[ChainPoller] Embedded ${embedded} posts into LanceDB`);

    // Update state to newest post (last in reversed array = newest)
    state.lastTxHash = posts[posts.length - 1].txHash;
    saveState();

    if (needsOptimize()) {
      await optimize();
    }
  } catch (err) {
    console.error("[ChainPoller] Poll error:", err.message);
  } finally {
    polling = false;
  }
}

/**
 * Start the chain poller loop.
 * @param {number} intervalMs - Polling interval (default 30s)
 */
export async function startChainPoller(intervalMs = 30_000) {
  loadState();
  console.log(`[ChainPoller] Starting (interval: ${intervalMs / 1000}s, lastTxHash: ${state.lastTxHash || "none"})`);

  // Initial poll
  await pollOnce();

  // Recurring polls
  setInterval(pollOnce, intervalMs);
}

// Standalone entry point
const isMain = process.argv[1] && (
  process.argv[1].endsWith("chain/poller.mjs") ||
  process.argv[1].includes("chain/poller")
);

if (isMain) {
  console.log("[ChainPoller] Running standalone");
  await initVectorStore();
  if (!isReady()) {
    console.error("[ChainPoller] Vector store not ready — check OPENAI_API_KEY and LanceDB path");
    process.exit(1);
  }
  await startChainPoller(30_000);
}

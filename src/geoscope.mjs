// Geoscope — Multi-Channel AI Geopolitical Analyst Agent
// Monitors multiple Telegram channels, embeds posts for cross-linking,
// and publishes enriched analysis to SuperColony.

import { channels, DRY_RUN, validateConfig } from "./config.mjs";
import { connectTelegram, joinChannel, getClient } from "./telegram/client.mjs";
import { MultiChannelPoller } from "./telegram/poller.mjs";
import { analyzePost, isPromotional, isMetaCommentary, categorize } from "./analysis/deepseek.mjs";
import { downloadAndExtract } from "./analysis/vision.mjs";
import { CrossLinker } from "./analysis/cross-linker.mjs";
import * as vectorStore from "./embeddings/store.mjs";
import { isAvailable as embeddingsAvailable } from "./embeddings/embedder.mjs";
import { connectDemos, attestUrl, publish } from "./publishing/demos.mjs";
import {
  authenticate,
  registerAgent,
  startAuthRefresh,
  stopAuthRefresh,
} from "./publishing/colony.mjs";
import { extractUrls, classifyUrls } from "./utils/urls.mjs";
import { resolveForwardSource } from "./utils/forward.mjs";
import { BackfillCrawler } from "./backfill/crawler.mjs";
import { scoreMessage } from "./backfill/scorer.mjs";
import { RetroLinker } from "./backfill/retro-linker.mjs";

const MIN_SUBSTANTIAL_LENGTH = 80;
const MAX_DEDUP_SIZE = 5000;
const processedMessages = new Set();

let crossLinker;
let poller;
let backfillCrawler;
let retroLinker;

// ── Message Processing ───────────────────────────────────────

async function processMessage(channel, message) {
  const messageId = message.id;
  const dedupKey = `${channel.username}:${messageId}`;

  if (processedMessages.has(dedupKey)) return;
  processedMessages.add(dedupKey);

  // Prevent unbounded memory growth
  if (processedMessages.size > MAX_DEDUP_SIZE) {
    const toDelete = [...processedMessages].slice(0, processedMessages.size - MAX_DEDUP_SIZE);
    for (const key of toDelete) processedMessages.delete(key);
  }

  let text = message.message || "";

  // Image handling for channels with hasImages flag
  if (!text && message.media && channel.hasImages) {
    console.log(`  [${channel.username}] Image message ${messageId}, running OCR...`);
    const extracted = await downloadAndExtract(getClient(), message);
    if (extracted) {
      text = extracted;
      console.log(`  [${channel.username}] OCR extracted: ${text.slice(0, 80)}...`);
    } else {
      console.log(`  [${channel.username}] OCR failed, skipping msg ${messageId}`);
      return;
    }
  }

  const urls = extractUrls(message);
  const { sourceUrls, promoUrls } = classifyUrls(urls, text, channel.username);

  if (promoUrls.length > 0) {
    console.log(
      `  [${channel.username}] Filtered ${promoUrls.length} promo URL(s)`
    );
  }

  // Skip if no source URLs AND no substantial text
  if (sourceUrls.length === 0 && text.length < MIN_SUBSTANTIAL_LENGTH) {
    console.log(
      `  [${channel.username}] Skipping msg ${messageId}: too short (${text.length} chars) and no source URLs`
    );
    return;
  }

  console.log(
    `  [${channel.username}] Processing msg ${messageId}: ${text.slice(0, 80)}...`
  );

  // Resolve forward source attribution
  let forwardSource = null;
  if (message.fwdFrom) {
    try {
      forwardSource = await resolveForwardSource(getClient(), message.fwdFrom);
      if (forwardSource) {
        console.log(`  [${channel.username}] Forwarded from: ${forwardSource.name}${forwardSource.tmeUrl ? ` (${forwardSource.tmeUrl})` : ""}`);
      }
    } catch (err) {
      console.warn(`  [${channel.username}] Forward resolve failed: ${err.message}`);
    }
  }

  // Cross-reference search (before analysis, to enrich the prompt)
  let crossReferences = [];
  if (crossLinker) {
    try {
      crossReferences = await crossLinker.findRelated(text, channel.username);
      if (crossReferences.length > 0) {
        const crossChannels = [
          ...new Set(crossReferences.map((r) => r.channel)),
        ].filter((c) => c !== channel.username);
        if (crossChannels.length > 0) {
          console.log(
            `  [${channel.username}] Cross-refs from: ${crossChannels.join(", ")}`
          );
        }
      }
    } catch (err) {
      console.warn(`  [${channel.username}] Cross-linking failed: ${err.message}`);
    }
  }

  // AI analysis
  const analysis = await analyzePost(text, sourceUrls, crossReferences, forwardSource);

  if (!analysis) {
    console.warn(`  [${channel.username}] Analysis failed for msg ${messageId}`);
    return;
  }

  if (isPromotional(analysis)) {
    console.log(`  [${channel.username}] Skipping msg ${messageId}: promotional`);
    return;
  }

  const skipPublish = isMetaCommentary(analysis);
  if (skipPublish) {
    console.log(`  [${channel.username}] [EMBED_ONLY] msg ${messageId}: meta-commentary filtered from publishing`);
  }

  // DAHR attestation for source URLs
  const attestations = [];
  for (const url of sourceUrls) {
    const attestation = await attestUrl(url);
    if (attestation) attestations.push(attestation);
  }

  // Confidence based on attestation success rate (floor 30, ceiling 90)
  const confidence =
    sourceUrls.length > 0
      ? Math.round((attestations.length / sourceUrls.length) * 60) + 30
      : 50;

  // Build tags from channel config + base tags
  const tags = [...new Set([...channel.tags, "telegram", "geoscope"])];

  // Build post text with optional forward attribution footer
  let postText = analysis;
  if (forwardSource) {
    const via = forwardSource.tmeUrl
      ? `\n\nvia ${forwardSource.name} (${forwardSource.tmeUrl})`
      : `\n\nvia ${forwardSource.name}`;
    const maxAnalysisLen = 1024 - via.length;
    postText = postText.slice(0, maxAnalysisLen) + via;
  }

  // Build post
  const post = {
    cat: categorize(text),
    text: postText.slice(0, 1024),
    assets: [],
    tags,
    confidence,
    sourceAttestations: attestations,
    payload: {
      source: "telegram",
      channel: channel.username,
      messageId,
      timestamp: message.date ? message.date * 1000 : Date.now(),
      urls: sourceUrls,
      originalText: text.slice(0, 2000),
      forwardSource: forwardSource || undefined,
      crossReferences:
        crossReferences.length > 0
          ? crossReferences.map((r) => ({
              channel: r.channel,
              messageId: r.messageId,
              topic: r.topic,
              similarity: r.similarity,
              text: r.text,
            }))
          : undefined,
    },
  };

  // Publish with retry (1 retry on transient failure)
  let published = false;
  if (!skipPublish) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await publish(post);
        published = true;
        break;
      } catch (err) {
        if (attempt < 2) {
          console.warn(
            `  [${channel.username}] Publish failed for msg ${messageId} (retrying): ${err.message}`
          );
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          console.error(
            `  [${channel.username}] Publish failed for msg ${messageId}:`,
            err.message
          );
        }
      }
    }

    if (!published) {
      console.warn(`  [${channel.username}] Msg ${messageId} NOT published — embedding only`);
    }
  }

  // Store embedding (even if publish failed, for future cross-linking)
  if (vectorStore.isReady()) {
    try {
      await vectorStore.store({
        channel: channel.username,
        topic: channel.topic,
        messageId,
        text,
        timestamp: message.date ? message.date * 1000 : Date.now(),
      });
    } catch (err) {
      console.warn(
        `  [${channel.username}] Embedding store failed for msg ${messageId}:`,
        err.message
      );
    }
  }
}

// ── Backfill batch processing ─────────────────────────────────

async function processBackfillBatch(channel, messages) {
  let fullCount = 0;
  let embedCount = 0;
  let skipCount = 0;
  const embeddedMessages = [];

  for (const message of messages) {
    const text = message.message || "";
    const { score, tier } = scoreMessage(text, message, channel);

    if (tier === "skip") {
      skipCount++;
      continue;
    }

    if (tier === "full") {
      fullCount++;
      try {
        await processMessage(channel, message);
      } catch (err) {
        console.error(`  [Backfill] ${channel.username} msg ${message.id} full-pipeline error:`, err.message);
      }
      continue;
    }

    // tier === "embed" — store in vector DB only
    if (vectorStore.isReady()) {
      embedCount++;
      const timestamp = message.date ? message.date * 1000 : Date.now();
      try {
        await vectorStore.store({
          channel: channel.username,
          topic: channel.topic,
          messageId: message.id,
          text,
          timestamp,
        });
        embeddedMessages.push({
          channel: channel.username,
          messageId: message.id,
          text,
          timestamp,
        });
      } catch (err) {
        console.warn(`  [Backfill] ${channel.username} embed failed for msg ${message.id}:`, err.message);
      }
    }
  }

  console.log(
    `[Backfill] ${channel.username} batch: ${messages.length} msgs → ` +
    `${fullCount} full, ${embedCount} embed, ${skipCount} skip`
  );

  // Update crawler stats
  if (backfillCrawler) {
    backfillCrawler.updateStats(channel.username, {
      full: fullCount,
      embedded: embedCount,
      processed: messages.length,
    });
  }

  // Check for retro-links on newly embedded messages
  if (retroLinker && embeddedMessages.length > 0) {
    try {
      const retroCount = await retroLinker.checkNewConnections(embeddedMessages);
      if (retroCount > 0) {
        console.log(`[Backfill] ${channel.username} — ${retroCount} retro-link(s) published`);
      }
    } catch (err) {
      console.warn(`[Backfill] ${channel.username} retro-link check failed:`, err.message);
    }
  }
}

// ── Handle batch of messages from a channel ──────────────────

async function onMessages(channel, messages) {
  for (const message of messages) {
    try {
      await processMessage(channel, message);
    } catch (err) {
      console.error(`  [${channel.username}] Uncaught error processing msg ${message.id}:`, err.message);
    }
  }
}

// ── Graceful Shutdown ────────────────────────────────────────

function setupShutdown() {
  const shutdown = () => {
    console.log("\nShutting down...");
    if (backfillCrawler) backfillCrawler.stop();
    if (poller) poller.stop();
    stopAuthRefresh();
    console.log("State saved. Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Startup Banner ───────────────────────────────────────────

function printBanner() {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║   Geoscope — Multi-Channel AI Geopolitical Analyst    ║");
  console.log("║   Cross-domain intelligence with vector linking       ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  if (DRY_RUN) {
    console.log("** DRY_RUN MODE — no blockchain transactions **\n");
  }

  console.log(`Channels (${channels.length}):`);
  for (const ch of channels) {
    const flags = [];
    if (ch.hasImages) flags.push("images");
    const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    console.log(
      `  @${ch.username} — ${ch.topic} (every ${ch.pollIntervalMs / 1000}s)${flagStr}`
    );
  }

  const embStatus = embeddingsAvailable() ? "OpenAI text-embedding-3-small" : "disabled (no OPENAI_API_KEY)";
  console.log(`\nEmbeddings: ${embStatus}`);
  console.log(`DAHR: source URL attestation`);
  console.log(`Analysis: DeepSeek AI\n`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  validateConfig();
  printBanner();
  setupShutdown();

  // Connect services
  await connectDemos();
  await authenticate();
  await registerAgent();
  startAuthRefresh();

  // Initialize vector store if embeddings available
  if (embeddingsAvailable()) {
    await vectorStore.init();
    if (vectorStore.isReady()) {
      crossLinker = new CrossLinker(vectorStore);
    }
  }

  // Connect Telegram and join all channels
  await connectTelegram();
  for (const ch of channels) {
    await joinChannel(ch.username);
  }

  // Start multi-channel poller
  const client = getClient();
  poller = new MultiChannelPoller(client, channels, onMessages);
  poller.start();

  console.log("Polling started. Press Ctrl+C to stop.\n");

  // Initialize backfill system
  if (vectorStore.isReady()) {
    retroLinker = new RetroLinker(vectorStore);

    backfillCrawler = new BackfillCrawler(client, channels, processBackfillBatch);

    // Seed each channel's starting position from poller state
    const pollerState = poller.getState();
    for (const ch of channels) {
      const chState = pollerState[ch.username];
      if (chState && chState.lastMessageId > 0) {
        backfillCrawler.seedChannel(ch.username, chState.lastMessageId);
      }
    }

    backfillCrawler.start();
  }
}

main().catch((err) => {
  if (err.errorMessage === "AUTH_KEY_DUPLICATED") {
    console.error("Fatal: Telegram session is invalid or used by another instance.");
    console.error("Delete .telegram-session.txt and re-run auth-session.mjs to create a new session.");
  } else {
    console.error("Fatal:", err);
  }
  process.exit(1);
});

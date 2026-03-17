/**
 * Geoscope MoltHive Agent (Bot API mode)
 *
 * Monitors a Telegram channel and publishes
 * verified observations to MoltHive using DAHR attestation.
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in your values
 *   2. npm install
 *   3. npm start
 *
 * Get free testnet DEM: https://faucet.demos.sh/
 * Get Telegram bot token from @BotFather
 */

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk";

// ── Config ────────────────────────────────────────────────────

const RPC_URL = process.env.DEMOS_RPC_URL || "https://demosnode.discus.sh/";
const MNEMONIC = process.env.DEMOS_MNEMONIC;
const COLONY_URL = process.env.COLONY_URL || "https://www.supercolony.ai";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000", 10); // 1 min default

if (!MNEMONIC) {
  console.error("Error: DEMOS_MNEMONIC is required in .env");
  process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN is required in .env");
  console.error("Get one from @BotFather on Telegram");
  process.exit(1);
}

// ── State ─────────────────────────────────────────────────────

let demos;
let agentAddress;
let authHeaders = {};
let lastUpdateId = 0;
const processedMessages = new Set(); // Track processed message IDs

// ── HIVE Encoding ─────────────────────────────────────────────

const HIVE_MAGIC = new Uint8Array([0x48, 0x49, 0x56, 0x45]); // "HIVE"

function encodePost(payload) {
  const json = JSON.stringify(payload);
  const jsonBytes = new TextEncoder().encode(json);
  const result = new Uint8Array(HIVE_MAGIC.length + jsonBytes.length);
  result.set(HIVE_MAGIC);
  result.set(jsonBytes, HIVE_MAGIC.length);
  return result;
}

// ── Demos Connection ──────────────────────────────────────────

async function connectDemos() {
  demos = new Demos();
  await demos.connect(RPC_URL);
  await demos.connectWallet(MNEMONIC);
  agentAddress = demos.getAddress();
  console.log(`✓ Connected to Demos as ${agentAddress}`);
  const info = await demos.getAddressInfo(agentAddress);
  console.log(`  Balance: ${info?.balance || 0} DEM`);
}

// ── SuperColony Authentication ────────────────────────────────

async function authenticateSuperColony() {
  try {
    // 1. Get challenge
    const challengeRes = await fetch(
      `${COLONY_URL}/api/auth/challenge?address=${agentAddress}`
    );
    const { challenge, message } = await challengeRes.json();

    // 2. Sign with Demos wallet
    const sig = await demos.signMessage(message);

    // 3. Exchange for 24h token
    const verifyRes = await fetch(`${COLONY_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: agentAddress,
        challenge,
        signature: sig.data,
        algorithm: sig.type || "ed25519",
      }),
    });
    const { token, expiresAt } = await verifyRes.json();

    authHeaders = { Authorization: `Bearer ${token}` };
    console.log(`✓ Authenticated with SuperColony (expires: ${new Date(expiresAt).toISOString()})`);
    return true;
  } catch (err) {
    console.error("Authentication failed:", err.message);
    return false;
  }
}

// ── DAHR Attestation ──────────────────────────────────────────

async function attestUrl(url) {
  try {
    const dahr = await demos.web2.createDahr();
    const proxyResponse = await dahr.startProxy({
      url,
      method: "GET",
    });

    return {
      url,
      responseHash: proxyResponse.responseHash,
      txHash: proxyResponse.txHash,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.warn(`DAHR attestation failed for ${url}:`, err.message);
    return null;
  }
}

// ── Publish a Post ────────────────────────────────────────────

async function publish(payload) {
  const bytes = encodePost({ v: 1, ...payload });

  const tx = await DemosTransactions.store(bytes, demos);
  const validity = await DemosTransactions.confirm(tx, demos);
  await DemosTransactions.broadcast(validity, demos);

  const txHash = tx.hash || tx.txHash || "unknown";
  console.log(`✓ Published [${payload.cat}]: ${payload.text.slice(0, 60)}...`);
  console.log(`  tx: https://scan.demos.network/transactions/${txHash}`);
  return txHash;
}

// ── Telegram Integration ──────────────────────────────────────

async function getTelegramUpdates() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
    const params = new URLSearchParams();
    if (lastUpdateId > 0) {
      params.append("offset", lastUpdateId + 1);
    }
    params.append("limit", "100");

    const res = await fetch(`${url}?${params}`);
    const data = await res.json();

    if (!data.ok) {
      console.warn("Telegram API error:", data.description);
      return [];
    }

    if (data.result.length > 0) {
      lastUpdateId = data.result[data.result.length - 1].update_id;
    }

    return data.result;
  } catch (err) {
    console.warn("Failed to fetch Telegram updates:", err.message);
    return [];
  }
}

function extractUrls(text) {
  if (!text) return [];
  // Match URLs (http/https)
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

function isChannelMessage(update) {
  // Check if it's a channel post from our target channel
  const message = update.channel_post || update.message;
  if (!message) return false;

  const chat = message.chat;
  if (!chat) return false;

  // Match by username or ID
  if (chat.username === TELEGRAM_CHANNEL.replace("@", "")) return true;
  if (chat.type === "channel" && TELEGRAM_CHANNEL.includes(String(chat.id))) return true;

  return false;
}

// ── Content Processing ────────────────────────────────────────

async function processChannelPost(message) {
  const messageId = message.message_id;

  // Skip already processed
  if (processedMessages.has(messageId)) {
    return;
  }
  processedMessages.add(messageId);

  const text = message.text || message.caption || "";
  const urls = extractUrls(text);

  // Phase 1: Only process messages with URLs
  if (urls.length === 0) {
    console.log(`⏭ Skipping message ${messageId}: no URLs found`);
    return;
  }

  console.log(`\n📨 Processing message ${messageId}:`);
  console.log(`   Text: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
  console.log(`   URLs found: ${urls.length}`);

  // Attest all URLs with DAHR
  const attestations = [];
  for (const url of urls) {
    console.log(`   🔍 Attesting: ${url}`);
    const attestation = await attestUrl(url);
    if (attestation) {
      attestations.push(attestation);
      console.log(`   ✓ Attested: ${attestation.txHash.slice(0, 20)}...`);
    }
  }

  // Determine category based on content
  let category = "OBSERVATION";
  const lowerText = text.toLowerCase();
  if (lowerText.includes("urgent") || lowerText.includes("breaking") || lowerText.includes("alert")) {
    category = "ALERT";
  } else if (lowerText.includes("analysis") || lowerText.includes("report")) {
    category = "ANALYSIS";
  }

  // Build post
  const post = {
    cat: category,
    text: text.slice(0, 1024), // Max 1024 chars
    assets: [],
    tags: ["geopolitics", "telegram", "geo-grandmasters"],
    confidence: 80,
    sourceAttestations: attestations,
    payload: {
      source: "telegram",
      channel: TELEGRAM_CHANNEL,
      messageId: messageId,
      timestamp: message.date * 1000,
      urls: urls,
    },
  };

  // Publish to MoltHive
  try {
    const txHash = await publish(post);
    console.log(`✓ Successfully published to MoltHive`);
  } catch (err) {
    console.error(`✗ Failed to publish:`, err.message);
  }
}

// ── Main Observation Loop ─────────────────────────────────────

async function observe() {
  try {
    const updates = await getTelegramUpdates();

    for (const update of updates) {
      if (isChannelMessage(update)) {
        const message = update.channel_post || update.message;
        await processChannelPost(message);
      }
    }
  } catch (err) {
    console.error("Observation error:", err.message);
  }
}

// ── Agent Registration ────────────────────────────────────────

async function registerAgent() {
  try {
    const res = await fetch(`${COLONY_URL}/api/agents/register`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "geoscope-relay",
        description: "Monitors Telegram channels and publishes verified geopolitical observations to the colony",
        specialties: ["geopolitics", "intelligence", "social-media"],
      }),
    });

    if (res.ok) {
      console.log("✓ Agent registered on SuperColony");
    } else if (res.status === 409) {
      console.log("ℹ Agent already registered");
    } else {
      console.warn("Agent registration:", await res.text());
    }
  } catch (err) {
    console.warn("Could not register agent:", err.message);
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║   GeoGrandmasters → MoltHive Agent                     ║");
  console.log("║   Monitors Telegram and publishes with DAHR proof      ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  // Connect to Demos
  await connectDemos();

  // Authenticate with SuperColony
  await authenticateSuperColony();

  // Register agent profile
  await registerAgent();

  console.log(`\n📡 Monitoring: ${TELEGRAM_CHANNEL}`);
  console.log(`⏱ Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`🔐 Verification: DAHR attestation for URLs\n`);

  // Initial check
  await observe();

  // Schedule periodic checks
  setInterval(async () => {
    // Refresh auth if needed (every 20 hours)
    await observe();
  }, CHECK_INTERVAL_MS);

  // Refresh auth every 20 hours
  setInterval(async () => {
    console.log("\n🔄 Refreshing SuperColony authentication...");
    await authenticateSuperColony();
  }, 20 * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

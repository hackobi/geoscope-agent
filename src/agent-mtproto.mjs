import "dotenv/config";
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { existsSync, readFileSync, writeFileSync } from "fs";
import OpenAI from "openai";

// ── Config ────────────────────────────────────────────────────

const RPC_URL = process.env.DEMOS_RPC_URL || "https://demosnode.discus.sh/";
const MNEMONIC = process.env.DEMOS_MNEMONIC;
const COLONY_URL = process.env.COLONY_URL || "https://www.supercolony.ai";

// Telegram MTProto credentials
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || "";
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;

const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000", 10);
const SESSION_FILE = ".telegram-session.txt";

// DeepSeek API
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!MNEMONIC) {
  console.error("Error: DEMOS_MNEMONIC is required in .env");
  process.exit(1);
}

if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
  console.error("Error: TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  console.error("Get them at: https://my.telegram.org/apps");
  process.exit(1);
}

if (!DEEPSEEK_API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY is required in .env");
  process.exit(1);
}

// ── DeepSeek Client ──────────────────────────────────────────

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// ── State ─────────────────────────────────────────────────────

let demos;
let agentAddress;
let authHeaders = {};
let telegramClient;
let lastMessageId = 0;
const processedMessages = new Set();

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
    const challengeRes = await fetch(
      `${COLONY_URL}/api/auth/challenge?address=${agentAddress}`
    );
    const { challenge, message } = await challengeRes.json();
    const sig = await demos.signMessage(message);

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
    console.log(`✓ Authenticated with SuperColony`);
    return true;
  } catch (err) {
    console.error("Authentication failed:", err.message);
    return false;
  }
}

// ── URL Classification ───────────────────────────────────────

const PROMO_KEYWORDS = /\b(join|boost|subscribe|chat|contact|support|channel|group)\b/i;

function classifyUrls(urls, text) {
  const sourceUrls = [];
  const promoUrls = [];

  for (const url of urls) {
    const lower = url.toLowerCase();

    // t.me invite links (t.me/+xxx)
    if (/t\.me\/\+/.test(lower)) {
      promoUrls.push(url);
      continue;
    }

    // t.me channel self-links (t.me/channelname matching source channel)
    if (/t\.me\//.test(lower)) {
      const tmeMatch = lower.match(/t\.me\/([a-z0-9_]+)/i);
      if (tmeMatch) {
        const handle = tmeMatch[1].toLowerCase();
        // Self-link to the source channel
        if (handle === TELEGRAM_CHANNEL.toLowerCase()) {
          promoUrls.push(url);
          continue;
        }
        // Bare t.me/username with no post ID → likely promo
        if (!/t\.me\/[a-z0-9_]+\/\d+/i.test(lower)) {
          promoUrls.push(url);
          continue;
        }
      }
    }

    // Bare social profile URLs (no article/status path)
    if (/^https?:\/\/(www\.)?(twitter|x)\.com\/[a-z0-9_]+\/?$/i.test(lower)) {
      promoUrls.push(url);
      continue;
    }

    // Check surrounding text for promotional keywords
    const urlIndex = text.indexOf(url);
    if (urlIndex !== -1) {
      const surroundingStart = Math.max(0, urlIndex - 80);
      const surroundingEnd = Math.min(text.length, urlIndex + url.length + 80);
      const surrounding = text.slice(surroundingStart, surroundingEnd);
      if (PROMO_KEYWORDS.test(surrounding) && !/t\.me\/[a-z0-9_]+\/\d+/i.test(lower)) {
        promoUrls.push(url);
        continue;
      }
    }

    // Everything else is a source URL
    sourceUrls.push(url);
  }

  return { sourceUrls, promoUrls };
}

// ── AI Analysis ──────────────────────────────────────────────

async function analyzePost(text, sourceUrls) {
  const urlContext = sourceUrls.length > 0
    ? `\n\nReferenced sources: ${sourceUrls.join(", ")}`
    : "";

  try {
    const response = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: "You are a geopolitical analyst writing observations for an intelligence feed. Write a concise analytical take (2-4 sentences) on the content below. Write as if making your own observation — never start with 'The post' or 'This post'. State the events and claims directly, assess significance, and note bias if present. If the content is purely promotional, an advertisement, or a channel plug with no geopolitical substance, respond with exactly: SKIP_PROMOTIONAL",
        },
        {
          role: "user",
          content: text + urlContext,
        },
      ],
      max_tokens: 300,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("DeepSeek analysis failed:", err.message);
    return null;
  }
}

// ── DAHR Attestation ──────────────────────────────────────────

async function attestUrl(url) {
  try {
    const dahr = await demos.web2.createDahr();
    const proxyResponse = await dahr.startProxy({ url, method: "GET" });

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

// ── Telegram MTProto Connection ───────────────────────────────

async function connectTelegram() {
  // Load saved session — required for headless operation
  let sessionString = TELEGRAM_SESSION;
  if (!sessionString && existsSync(SESSION_FILE)) {
    sessionString = readFileSync(SESSION_FILE, "utf8").trim();
  }

  if (!sessionString) {
    console.error("❌ No Telegram session found!");
    console.error("Run auth-session.mjs first to create a session.");
    process.exit(1);
  }

  telegramClient = new TelegramClient(
    new StringSession(sessionString),
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    {
      connectionRetries: 5,
    }
  );

  await telegramClient.connect();
  console.log("✓ Connected to Telegram");

  // Join the channel if not already a member
  try {
    const entity = await telegramClient.getEntity(TELEGRAM_CHANNEL);
    console.log(`✓ Accessing channel: ${TELEGRAM_CHANNEL}`);

    // Check if we're already in the channel
    try {
      await telegramClient.getParticipant(entity, await telegramClient.getMe());
      console.log("  Already a member");
    } catch {
      console.log("  Joining channel...");
      await telegramClient.invoke(new telegramClient.constructor.Api.channels.JoinChannel({
        channel: entity,
      }));
      console.log("  Joined successfully");
    }
  } catch (err) {
    console.warn("Could not join channel:", err.message);
    console.log("  Will try to read as public channel");
  }
}

// ── Fetch Channel Messages ────────────────────────────────────

async function fetchChannelMessages() {
  try {
    const messages = await telegramClient.getMessages(TELEGRAM_CHANNEL, {
      limit: 20,
      minId: lastMessageId,
    });

    // Filter new messages (MTProto returns newest first)
    const newMessages = messages
      .filter(m => m.id > lastMessageId && m.message)
      .reverse(); // Process oldest first

    if (newMessages.length > 0) {
      lastMessageId = Math.max(...messages.map(m => m.id));
    }

    return newMessages;
  } catch (err) {
    console.warn("Failed to fetch messages:", err.message);
    return [];
  }
}

// ── Content Processing ────────────────────────────────────────

function extractUrls(message) {
  const urls = new Set();
  const text = message.message || "";

  // Extract from plain text
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  for (const match of text.matchAll(urlRegex)) {
    urls.add(match[1]);
  }

  // Extract from Telegram message entities (hidden hyperlinks, text URLs)
  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.className === "MessageEntityTextUrl" && entity.url) {
        urls.add(entity.url);
      } else if (entity.className === "MessageEntityUrl") {
        const entityUrl = text.slice(entity.offset, entity.offset + entity.length);
        if (/^https?:\/\//i.test(entityUrl)) {
          urls.add(entityUrl);
        }
      }
    }
  }

  return [...urls];
}

const MIN_SUBSTANTIAL_LENGTH = 80;

async function processMessage(message) {
  const messageId = message.id;

  if (processedMessages.has(messageId)) {
    return;
  }
  processedMessages.add(messageId);

  const text = message.message || "";
  const urls = extractUrls(message);

  // Classify URLs
  const { sourceUrls, promoUrls } = classifyUrls(urls, text);

  if (promoUrls.length > 0) {
    console.log(`   🗑 Filtered ${promoUrls.length} promo URL(s): ${promoUrls.join(", ")}`);
  }

  // Skip if no source URLs AND no substantial text
  if (sourceUrls.length === 0 && text.length < MIN_SUBSTANTIAL_LENGTH) {
    console.log(`⏭ Skipping message ${messageId}: no source URLs and short text`);
    return;
  }

  console.log(`\n📨 Processing message ${messageId}:`);
  console.log(`   Text: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
  console.log(`   Source URLs: ${sourceUrls.length}, Promo URLs: ${promoUrls.length}`);

  // AI analysis
  console.log(`   🧠 Analyzing with DeepSeek...`);
  const analysis = await analyzePost(text, sourceUrls);

  if (!analysis) {
    console.warn(`   ⚠ Analysis failed, skipping message ${messageId}`);
    return;
  }

  const lowerAnalysis = analysis.toLowerCase();
  if (
    analysis.includes("SKIP_PROMOTIONAL") ||
    (lowerAnalysis.includes("promot") && (lowerAnalysis.includes("channel") || lowerAnalysis.includes("advert"))) ||
    lowerAnalysis.startsWith("this is a promot") ||
    lowerAnalysis.startsWith("this channel promot")
  ) {
    console.log(`   🗑 Skipping message ${messageId}: AI flagged as promotional`);
    return;
  }

  console.log(`   ✓ Analysis: ${analysis.slice(0, 80)}...`);

  // Attest only source URLs with DAHR
  const attestations = [];
  for (const url of sourceUrls) {
    console.log(`   🔍 Attesting: ${url}`);
    const attestation = await attestUrl(url);
    if (attestation) {
      attestations.push(attestation);
      console.log(`   ✓ Attested`);
    }
  }

  // Determine category
  let category = "OBSERVATION";
  const lowerText = text.toLowerCase();
  if (lowerText.includes("urgent") || lowerText.includes("breaking") || lowerText.includes("alert")) {
    category = "ALERT";
  } else if (lowerText.includes("analysis") || lowerText.includes("report")) {
    category = "ANALYSIS";
  }

  // Confidence based on attestation success rate
  const confidence = sourceUrls.length > 0
    ? Math.round((attestations.length / sourceUrls.length) * 80) + 10
    : 50; // Lower confidence when no source URLs to attest

  // Build and publish post
  const post = {
    cat: category,
    text: analysis.slice(0, 1024),
    assets: [],
    tags: ["geopolitics", "telegram", "geoscope"],
    confidence,
    sourceAttestations: attestations,
    payload: {
      source: "telegram",
      channel: TELEGRAM_CHANNEL,
      messageId: messageId,
      timestamp: message.date ? message.date * 1000 : Date.now(),
      urls: sourceUrls,
      originalText: text,
    },
  };

  try {
    await publish(post);
    console.log(`✓ Published to MoltHive`);
  } catch (err) {
    console.error(`✗ Failed to publish:`, err.message);
  }
}

// ── Main Observation Loop ─────────────────────────────────────

async function observe() {
  try {
    const messages = await fetchChannelMessages();

    for (const message of messages) {
      await processMessage(message);
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
        name: "geoscope",
        description: "AI-powered geopolitical analyst that monitors Telegram channels, filters promotional content, and publishes verified analytical observations",
        specialties: ["geopolitics", "intelligence", "analysis"],
      }),
    });

    if (res.ok) {
      console.log("✓ Agent registered");
    } else if (res.status === 409) {
      console.log("ℹ Agent already registered");
    }
  } catch (err) {
    console.warn("Registration skipped:", err.message);
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║   Geoscope — AI Geopolitical Analyst Agent            ║");
  console.log("║   Analyzes Telegram channels, publishes insights      ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  // Connect to services
  await connectDemos();
  await authenticateSuperColony();
  await connectTelegram();
  await registerAgent();

  console.log(`\n📡 Monitoring: @${TELEGRAM_CHANNEL}`);
  console.log(`⏱ Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`🔐 Verification: DAHR attestation for source URLs`);
  console.log(`🧠 Analysis: DeepSeek AI\n`);

  // Initial check
  await observe();

  // Schedule periodic checks
  setInterval(observe, CHECK_INTERVAL_MS);

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

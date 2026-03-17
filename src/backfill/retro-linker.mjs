// RetroLinker — discovers old↔recent connections from backfill embeddings
// and generates ANALYSIS posts for significant temporal links.

import OpenAI from "openai";
import { DEEPSEEK_API_KEY, DRY_RUN } from "../config.mjs";
import { publish } from "../publishing/demos.mjs";
import { isMetaCommentary, isPromotional } from "../analysis/deepseek.mjs";

const SIMILARITY_THRESHOLD = 0.72;
const MIN_AGE_GAP_MS = 24 * 60 * 60 * 1000; // 1 day
const MAX_RECENT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PER_BATCH = 3;
const SEARCH_LIMIT = 10;

const RETRO_SYSTEM_PROMPT =
  "You are a geopolitical analyst specializing in temporal pattern recognition. " +
  "Given a HISTORICAL message and a RECENT message that are semantically related, " +
  "write a concise analysis (3-5 sentences) explaining the connection between these events. " +
  "Focus on: how the historical context illuminates the recent development, " +
  "whether this represents escalation/de-escalation/continuation, " +
  "and what the temporal pattern suggests about the trajectory of events. " +
  "Write as your own observation — never start with 'The post' or 'This message'. " +
  "DO NOT comment on channel behavior, message repetition patterns, propaganda tactics, or content distribution strategies. " +
  "DO NOT describe messages as 'identical', 'promotional', or 'repetitive'. " +
  "Focus ONLY on the actual geopolitical events and their significance. " +
  "If both messages are essentially the same promotional or repetitive content with no real geopolitical substance, respond with exactly: SKIP_NO_SUBSTANCE";

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export class RetroLinker {
  /**
   * @param {object} vectorStore — the embeddings/store module
   */
  constructor(vectorStore) {
    this.store = vectorStore;
    this.publishedPairs = new Set(); // "oldChannel:oldId↔newChannel:newId"
  }

  /**
   * Check for old↔recent connections among newly embedded messages.
   * @param {Array} embeddedMessages — messages that were just embedded
   *   Each: { channel, messageId, text, timestamp }
   * @returns {number} count of retro-analyses published
   */
  async checkNewConnections(embeddedMessages) {
    if (!this.store || !this.store.isReady()) return 0;
    if (!embeddedMessages || embeddedMessages.length === 0) return 0;

    let published = 0;
    const now = Date.now();

    for (const msg of embeddedMessages) {
      if (published >= MAX_PER_BATCH) break;

      try {
        const results = await this.store.search(msg.text, SEARCH_LIMIT);
        if (!results || results.length === 0) continue;

        for (const match of results) {
          if (published >= MAX_PER_BATCH) break;

          const similarity = match._distance !== undefined ? 1 - match._distance : 0;
          if (similarity < SIMILARITY_THRESHOLD) continue;

          // Skip self-matches
          if (match.channel === msg.channel && match.messageId === msg.messageId) continue;

          const matchTime = match.timestamp || 0;
          const msgTime = msg.timestamp || 0;

          // Determine which is older, which is newer
          const [older, newer] = msgTime < matchTime
            ? [msg, { channel: match.channel, messageId: match.messageId, text: match.text, timestamp: matchTime }]
            : [{ channel: match.channel, messageId: match.messageId, text: match.text, timestamp: matchTime }, msg];

          // Age gap must be ≥ 1 day
          const ageGap = Math.abs(matchTime - msgTime);
          if (ageGap < MIN_AGE_GAP_MS) continue;

          // The newer message must be recent (within 7 days of now)
          if (now - newer.timestamp > MAX_RECENT_AGE_MS) continue;

          // Dedup
          const pairKey = `${older.channel}:${older.messageId}↔${newer.channel}:${newer.messageId}`;
          if (this.publishedPairs.has(pairKey)) continue;

          // Generate retro-analysis
          const analysis = await this._generateAnalysis(older, newer, similarity);
          if (!analysis) continue;

          // Filter meta-commentary and promotional content
          if (isMetaCommentary(analysis) || isPromotional(analysis)) {
            console.log(
              `[RetroLink] Filtered meta-commentary: ${older.channel}:${older.messageId} ↔ ` +
              `${newer.channel}:${newer.messageId}`
            );
            this.publishedPairs.add(pairKey); // prevent retrying
            continue;
          }

          // Publish
          try {
            const post = {
              cat: "ANALYSIS",
              text: analysis.slice(0, 1024),
              assets: [],
              tags: ["retro-link", "cross-temporal", "telegram", "geoscope"],
              confidence: Math.round(similarity * 100),
              payload: {
                source: "backfill-retro-link",
                historicalChannel: older.channel,
                historicalMessageId: older.messageId,
                historicalTimestamp: older.timestamp,
                recentChannel: newer.channel,
                recentMessageId: newer.messageId,
                recentTimestamp: newer.timestamp,
                similarity: parseFloat(similarity.toFixed(3)),
              },
            };

            await publish(post);
            this.publishedPairs.add(pairKey);
            published++;

            console.log(
              `[RetroLink] Published ANALYSIS: ${older.channel}:${older.messageId} ↔ ` +
              `${newer.channel}:${newer.messageId} (sim: ${similarity.toFixed(2)})`
            );
          } catch (err) {
            console.warn(`[RetroLink] Publish failed: ${err.message}`);
          }

          // Only process one match per source message
          break;
        }
      } catch (err) {
        console.warn(`[RetroLink] Search failed for msg ${msg.messageId}: ${err.message}`);
      }
    }

    return published;
  }

  async _generateAnalysis(older, newer, similarity) {
    const prompt =
      `HISTORICAL (${new Date(older.timestamp).toISOString().slice(0, 10)}, ` +
      `${older.channel}):\n${(older.text || "").slice(0, 500)}\n\n` +
      `RECENT (${new Date(newer.timestamp).toISOString().slice(0, 10)}, ` +
      `${newer.channel}):\n${(newer.text || "").slice(0, 500)}\n\n` +
      `Similarity: ${similarity.toFixed(2)}`;

    try {
      const response = await deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: RETRO_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.3,
      });
      return response.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
      console.warn(`[RetroLink] DeepSeek analysis failed: ${err.message}`);
      return null;
    }
  }
}

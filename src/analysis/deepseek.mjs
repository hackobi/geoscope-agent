// DeepSeek AI analysis for geopolitical content

import OpenAI from "openai";
import { DEEPSEEK_API_KEY } from "../config.mjs";

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const SYSTEM_PROMPT_BASE =
  "You are a geopolitical analyst writing observations for an intelligence feed. Write a concise analytical take (2-4 sentences) on the content below. Write as if making your own observation — never start with 'The post' or 'This post'. State the events and claims directly, assess significance, and note bias if present. DO NOT comment on channel behavior, message repetition, propaganda tactics, or content distribution patterns. Focus exclusively on the geopolitical events, claims, and their significance. If the content is purely promotional, an advertisement, or a channel plug with no geopolitical substance, respond with exactly: SKIP_PROMOTIONAL. If the content has no substantive geopolitical intelligence (only channel plugs, repetitive messages, or meta-content about how channels operate), respond with exactly: SKIP_NO_SUBSTANCE";

export async function analyzePost(text, sourceUrls, crossReferences = [], forwardSource = null) {
  const urlContext =
    sourceUrls.length > 0
      ? `\n\nReferenced sources: ${sourceUrls.join(", ")}`
      : "";

  let forwardContext = "";
  if (forwardSource) {
    const link = forwardSource.tmeUrl ? ` — ${forwardSource.tmeUrl}` : "";
    forwardContext = `\n\n[Forwarded from: ${forwardSource.name}${link}]\nYou may reference the original source by name in your analysis.`;
  }

  let crossRefContext = "";
  if (crossReferences.length > 0) {
    const refs = crossReferences
      .map(
        (r) =>
          `- [${r.topic}/${r.channel}] (similarity: ${r.similarity.toFixed(2)}): ${r.text}`
      )
      .join("\n");
    crossRefContext = `\n\nRelated posts from other channels:\n${refs}\n\nIf these cross-references reveal a multi-domain pattern (e.g. a geopolitical event also trending in economic or cultural channels), note the cross-domain resonance in your analysis.`;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_BASE },
          { role: "user", content: text + urlContext + crossRefContext + forwardContext },
        ],
        max_tokens: 300,
        temperature: 0.3,
      });

      return response.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
      const isTransient = err.status === 429 || err.status >= 500 ||
        err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (attempt < 2 && isTransient) {
        console.warn(`DeepSeek analysis failed (retrying): ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.warn("DeepSeek analysis failed:", err.message);
        return null;
      }
    }
  }
  return null;
}

export function isPromotional(analysis) {
  if (!analysis) return false;
  const lower = analysis.toLowerCase();
  return (
    lower.includes("skip_promotional") ||
    (lower.includes("promot") &&
      (lower.includes("channel") || lower.includes("advert"))) ||
    lower.startsWith("this is a promot") ||
    lower.startsWith("this channel promot")
  );
}

export function isMetaCommentary(analysis) {
  if (!analysis) return false;
  const lower = analysis.toLowerCase();
  if (lower.includes("skip_no_substance")) return true;
  const patterns = [
    /identical\s.*messages?\s.*channel/i,
    /identical\s.*(?:promotional|messages?|posts?).*(?:posted|sent|shared)/i,
    /near-identical\s.*(?:repetition|repost|message|narrative)/i,
    /repetitive\s.*(?:across|multiple|same)/i,
    /(?:the|this)\s+channel\s.*(?:posts?|shares?|distributes?|promotes?)/i,
    /propaganda\s.*(?:tactic|strategy|pattern)/i,
    /content\s.*distribution\s.*pattern/i,
    /(?:the|this)\s+(?:appears?\s+to\s+be|is)\s+(?:a\s+)?(?:repost|duplicate|copy)/i,
    /channel\s.*(?:behavior|behaviour|pattern|strategy)/i,
    /(?:systematic|deliberate)\s+(?:channel|messaging)\s+strategy/i,
    /(?:posted|shared)\s+(?:one|two|three|four|five|\d+)\s+(?:week|day|month)s?\s+apart/i,
    /information\s+campaign/i,
  ];
  return patterns.some((p) => p.test(analysis));
}

export function categorize(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes("urgent") ||
    lower.includes("breaking") ||
    lower.includes("alert")
  ) {
    return "ALERT";
  }
  if (lower.includes("analysis") || lower.includes("report")) {
    return "ANALYSIS";
  }
  return "OBSERVATION";
}

// OpenAI text-embedding-3-small wrapper

import OpenAI from "openai";
import { OPENAI_API_KEY } from "../config.mjs";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;

let client;

function getClient() {
  if (!client) {
    if (!OPENAI_API_KEY) return null;
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

export async function embed(text) {
  const openai = getClient();
  if (!openai) return null;

  try {
    const response = await openai.embeddings.create({
      model: MODEL,
      input: text.slice(0, 8000), // Token safety limit
    });
    return response.data[0].embedding;
  } catch (err) {
    console.warn("Embedding failed:", err.message);
    return null;
  }
}

export function isAvailable() {
  return !!OPENAI_API_KEY;
}

export { DIMENSIONS };

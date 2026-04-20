// HIVE post decoder — ports logic from SuperColony's codec.ts
// Posts on-chain: 4-byte magic prefix (0x48495645 = "HIVE") + JSON body

const HIVE_MAGIC = new Uint8Array([0x48, 0x49, 0x56, 0x45]);
const MAX_PAYLOAD_BYTES = 32_768;
const MAX_TEXT_LENGTH = 1024;

const VALID_CATEGORIES = new Set([
  "OBSERVATION", "ANALYSIS", "PREDICTION", "ALERT",
  "ACTION", "SIGNAL", "QUESTION", "OPINION", "VOTE",
]);

function isHivePost(bytes) {
  if (bytes.length < HIVE_MAGIC.length + 2) return false;
  for (let i = 0; i < HIVE_MAGIC.length; i++) {
    if (bytes[i] !== HIVE_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Decode a base64-encoded HIVE post from an Explorer API storage transaction.
 * @param {string} base64Data - base64-encoded bytes from tx.raw_data.content.data[1].bytes
 * @returns {object|null} Decoded post payload or null if invalid
 */
export function decodeHivePost(base64Data) {
  try {
    const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));

    if (!isHivePost(bytes)) return null;

    const jsonBytes = bytes.subarray(HIVE_MAGIC.length);
    if (jsonBytes.length > MAX_PAYLOAD_BYTES) return null;

    const json = new TextDecoder().decode(jsonBytes);
    const parsed = JSON.parse(json);

    // Validate required fields
    if (parsed.v !== 1) return null;
    if (!VALID_CATEGORIES.has(parsed.cat)) return null;
    if (typeof parsed.text !== "string") return null;
    if (parsed.text.length > MAX_TEXT_LENGTH) return null;
    if (parsed.payload && typeof parsed.payload !== "object") return null;
    if (parsed.assets && (!Array.isArray(parsed.assets) || parsed.assets.length > 20)) return null;
    if (parsed.tags && (!Array.isArray(parsed.tags) || parsed.tags.length > 20)) return null;

    // Normalize replyTo (some agents nest it inside payload.payload)
    if (!parsed.replyTo && parsed.payload?.replyTo && typeof parsed.payload.replyTo === "string") {
      parsed.replyTo = parsed.payload.replyTo;
    }

    return parsed;
  } catch {
    return null;
  }
}

export { VALID_CATEGORIES };

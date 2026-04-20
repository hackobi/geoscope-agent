// Explorer API client for reading Demos blockchain transactions
// Endpoint: https://apiscan.demos.network/transactions

const BASE_URL = process.env.EXPLORER_API_URL || "https://apiscan.demos.network";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 4;

/**
 * Fetch a page of transactions from the Explorer API.
 * @param {number} limit - Number of transactions per page (default 50)
 * @param {string|null} cursor - Pagination cursor (null for first page)
 * @returns {{ data: object[], pagination: { nextCursor: string|null, hasMore: boolean } }}
 */
export async function fetchTransactions(limit = 50, cursor = null) {
  const url = new URL(`${BASE_URL}/transactions`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        const backoff = 5000 * Math.pow(2, attempt);
        console.warn(`[Explorer] Rate limited, backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Explorer API ${res.status}: ${res.statusText}`);
      }

      const body = await res.json();
      return {
        data: body.data || [],
        pagination: body.pagination || { nextCursor: null, hasMore: false },
      };
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn(`[Explorer] Request timed out (attempt ${attempt + 1}/${MAX_RETRIES})`);
      } else if (attempt === MAX_RETRIES - 1) {
        throw err;
      } else {
        console.warn(`[Explorer] Fetch error: ${err.message} (attempt ${attempt + 1}/${MAX_RETRIES})`);
      }
      await sleep(2000 * Math.pow(2, attempt));
    }
  }

  return { data: [], pagination: { nextCursor: null, hasMore: false } };
}

/**
 * Extract a decoded HIVE post's raw data from an Explorer transaction.
 * @param {object} tx - Explorer transaction object
 * @returns {{ base64: string, author: string, txHash: string, timestamp: string } | null}
 */
export function extractStorageTx(tx) {
  if (tx.tx_type !== "storage") return null;

  const data = tx.raw_data?.content?.data;
  if (!Array.isArray(data) || data.length < 2) return null;

  const bytes = data[1]?.bytes;
  if (!bytes) return null;

  const author =
    tx.raw_data?.content?.from_ed25519_address ||
    tx.raw_data?.content?.from ||
    tx.from_address;

  return {
    base64: bytes,
    author: author || "unknown",
    txHash: tx.hash,
    timestamp: tx.timestamp || tx.raw_data?.content?.timestamp,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// HIVE format: 4-byte magic + UTF-8 JSON payload

const HIVE_MAGIC = new Uint8Array([0x48, 0x49, 0x56, 0x45]); // "HIVE"

export function encodePost(payload) {
  const json = JSON.stringify(payload);
  const jsonBytes = new TextEncoder().encode(json);
  const result = new Uint8Array(HIVE_MAGIC.length + jsonBytes.length);
  result.set(HIVE_MAGIC);
  result.set(jsonBytes, HIVE_MAGIC.length);
  return result;
}

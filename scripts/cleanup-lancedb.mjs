// One-time LanceDB cleanup — removes old versions to reclaim disk space.
// Usage: npx tsx --env-file=.env scripts/cleanup-lancedb.mjs
// IMPORTANT: Stop the geoscope agent before running this.

const lancedb = await import("@lancedb/lancedb");

const db = await lancedb.connect("./data/lancedb");
const table = await db.openTable("posts");

const version = await table.version();
const count = await table.countRows();
console.log(`Table 'posts': version ${version}, ${count} rows`);

// Step 1: Compact fragments (merge small data files)
console.log("\n[1/2] Running compaction + default prune (older than 7 days)...");
const stats1 = await table.optimize({});
console.log("  Compaction:", JSON.stringify(stats1.compaction));
console.log("  Prune:", JSON.stringify(stats1.prune));

// Step 2: Aggressive cleanup — remove ALL old versions except current
console.log("\n[2/2] Running aggressive prune (all old versions)...");
const stats2 = await table.optimize({ cleanupOlderThan: new Date() });
console.log("  Prune:", JSON.stringify(stats2.prune));

// Verify
const postCount = await table.countRows();
const postVersion = await table.version();
console.log(`\nDone. Table 'posts': version ${postVersion}, ${postCount} rows (should match original ${count})`);
console.log("Check disk: du -sh data/lancedb/");

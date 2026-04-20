import { NextResponse } from "next/server";
import { connect } from "@lancedb/lancedb";
import path from "path";

const GEOSCOPE_ROOT = process.env.GEOSCOPE_ROOT || path.resolve(process.cwd(), "..");

export async function GET() {
  try {
    const dbPath = path.join(GEOSCOPE_ROOT, "data/lancedb");
    const db = await connect(dbPath);
    const table = await db.openTable("posts");

    const results = await table
      .query()
      .where("channel LIKE 'sc:%'")
      .select(["topic", "timestamp"])
      .toArray();

    const categories: Record<string, number> = {};
    let lastIngested = 0;

    for (const row of results) {
      const r = row as { topic: string; timestamp: number };
      categories[r.topic] = (categories[r.topic] || 0) + 1;
      if (r.timestamp > lastIngested) lastIngested = r.timestamp;
    }

    return NextResponse.json({
      totalPosts: results.length,
      categories,
      lastIngested: lastIngested || null,
    });
  } catch (error) {
    console.error("Chain stats error:", error);
    return NextResponse.json({ totalPosts: 0, categories: {}, lastIngested: null });
  }
}

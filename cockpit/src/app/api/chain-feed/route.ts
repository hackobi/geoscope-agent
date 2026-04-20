import { NextRequest, NextResponse } from "next/server";
import { connect } from "@lancedb/lancedb";
import path from "path";

const GEOSCOPE_ROOT = process.env.GEOSCOPE_ROOT || path.resolve(process.cwd(), "..");

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
    const category = searchParams.get("category")?.toLowerCase();

    const dbPath = path.join(GEOSCOPE_ROOT, "data/lancedb");
    const db = await connect(dbPath);
    const table = await db.openTable("posts");

    let filter = "channel LIKE 'sc:%'";
    if (category) {
      filter += ` AND topic = '${category.replace(/'/g, "''")}'`;
    }

    const results = await table
      .query()
      .where(filter)
      .limit(limit)
      .toArray();

    // Sort by timestamp descending (newest first)
    const posts = results
      .map((r: unknown) => {
        const row = r as {
          channel: string;
          messageId: number;
          text: string;
          timestamp: number;
          topic: string;
        };
        return {
          channel: row.channel,
          messageId: row.messageId,
          text: row.text,
          timestamp: row.timestamp,
          topic: row.topic,
          author: row.channel.replace("sc:", ""),
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json(posts);
  } catch (error) {
    console.error("Chain feed error:", error);
    return NextResponse.json([], { status: 200 });
  }
}

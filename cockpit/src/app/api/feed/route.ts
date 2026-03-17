import { NextRequest, NextResponse } from "next/server";
import { getFeed } from "@/lib/geoscope";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const category = searchParams.get("category") as "ALERT" | "ANALYSIS" | "OBSERVATION" | null;
  const minConfidence = searchParams.get("minConfidence");
  const maxConfidence = searchParams.get("maxConfidence");

  const filters: {
    category?: "ALERT" | "ANALYSIS" | "OBSERVATION";
    minConfidence?: number;
    maxConfidence?: number;
  } = {};

  if (category) filters.category = category;
  if (minConfidence) filters.minConfidence = parseInt(minConfidence, 10);
  if (maxConfidence) filters.maxConfidence = parseInt(maxConfidence, 10);

  const feed = getFeed(100, Object.keys(filters).length > 0 ? filters : undefined);
  return NextResponse.json(feed);
}

import { NextRequest, NextResponse } from "next/server";
import { searchEmbeddings } from "@/lib/vector-search";

export const dynamic = "force-dynamic";

/**
 * Vector search endpoint (CORS-enabled, optionally authenticated)
 *
 * POST /api/search
 * Body: { text: string, limit?: number }
 * Headers (optional): X-API-Key — checked against SEARCH_API_KEY env var if set
 *
 * CORS: Allowed origins configurable via SEARCH_CORS_ORIGINS env var (comma-separated).
 *       Defaults to "*" if not set.
 */

function corsHeaders(): Record<string, string> {
  const origins = process.env.SEARCH_CORS_ORIGINS || "*";
  return {
    "Access-Control-Allow-Origin": origins,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  };
}

function checkApiKey(request: NextRequest): boolean {
  const requiredKey = process.env.SEARCH_API_KEY;
  if (!requiredKey) return true; // no key configured = open access
  const provided = request.headers.get("X-API-Key");
  return provided === requiredKey;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  const headers = corsHeaders();

  if (!checkApiKey(request)) {
    return NextResponse.json(
      { error: "Invalid or missing API key", results: [] },
      { status: 401, headers }
    );
  }

  try {
    const body = await request.json();
    const { text, limit = 10 } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'text' parameter", results: [] },
        { status: 400, headers }
      );
    }

    const results = await searchEmbeddings(text, limit);
    return NextResponse.json({ results }, { headers });
  } catch (error) {
    console.error("Search API error:", error);
    return NextResponse.json(
      { error: "Search failed", results: [] },
      { status: 500, headers }
    );
  }
}

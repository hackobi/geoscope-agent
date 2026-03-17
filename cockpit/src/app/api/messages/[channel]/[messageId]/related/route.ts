import { NextRequest, NextResponse } from "next/server";
import { getRelatedMessages } from "@/lib/vector-search";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ channel: string; messageId: string }> }
) {
  try {
    const params = await context.params;
    const { channel, messageId } = params;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "5", 10);

    const related = await getRelatedMessages(channel, parseInt(messageId, 10), limit);
    return NextResponse.json({ related });
  } catch (error) {
    console.error("Related messages API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch related messages", related: [] },
      { status: 500 }
    );
  }
}

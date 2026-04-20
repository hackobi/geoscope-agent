// Stories API — returns active story clusters from data/stories.json

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GEOSCOPE_ROOT = process.env.GEOSCOPE_ROOT || path.resolve(process.cwd(), "..");
const STORIES_FILE = path.join(GEOSCOPE_ROOT, "data/stories.json");

export const dynamic = "force-dynamic";

interface StoryPost {
  channel: string;
  messageId: number;
  similarity: number;
  addedAt: number;
}

interface Story {
  id: string;
  title: string;
  topic: string;
  firstSeen: number;
  lastSeen: number;
  postCount: number;
  hasAlert: boolean;
  archived: boolean;
  channels: string[];
  posts: StoryPost[];
}

export async function GET() {
  try {
    if (!fs.existsSync(STORIES_FILE)) {
      return NextResponse.json({ stories: [] });
    }
    const raw = JSON.parse(fs.readFileSync(STORIES_FILE, "utf-8")) as { stories: Story[] };
    const active = (raw.stories || [])
      .filter((s) => !s.archived && s.postCount >= 2)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        title: s.title,
        topic: s.topic,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        postCount: s.postCount,
        hasAlert: s.hasAlert,
        channels: s.channels,
      }));
    return NextResponse.json({ stories: active });
  } catch (error) {
    console.error("Stories API error:", error);
    return NextResponse.json({ stories: [] });
  }
}

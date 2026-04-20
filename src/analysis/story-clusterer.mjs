// Story Clusterer — groups related posts into named stories
// Uses cross-references already computed by CrossLinker to cluster posts.
// Stories persist to data/stories.json; anything older than STORY_TTL_MS is archived.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";

const STORIES_FILE = "data/stories.json";
const STORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — archive inactive stories
const SIMILARITY_JOIN_THRESHOLD = 0.70;    // cross-ref similarity to join existing story
const MIN_POSTS_FOR_STORY = 2;             // min posts before a story is considered real

function ensureDataDir() {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
}

function loadStories() {
  try {
    if (existsSync(STORIES_FILE)) {
      const raw = JSON.parse(readFileSync(STORIES_FILE, "utf8"));
      return raw.stories || [];
    }
  } catch { /* ignore */ }
  return [];
}

function saveStories(stories) {
  try {
    ensureDataDir();
    writeFileSync(STORIES_FILE, JSON.stringify({ stories }, null, 2));
  } catch (err) {
    console.warn("[Stories] Failed to save:", err.message);
  }
}

export class StoryClusterer {
  constructor() {
    this.stories = loadStories();
  }

  /**
   * Process a new post against existing stories.
   * Returns the storyId if the post was added to or created a story, otherwise null.
   *
   * @param {object} post - { channel, messageId, text, topic, category, crossReferences }
   *   crossReferences: [{ channel, messageId, topic, similarity, text }]
   */
  process(post) {
    const now = Date.now();
    this._pruneOld(now);

    const { channel, messageId, text, topic, category, crossReferences = [] } = post;

    // Only cluster ALERTs and ANALYSIs — OBSERVATIONs are too noisy
    if (category === "OBSERVATION") return null;

    // Find candidate stories from cross-references
    const candidateStoryIds = new Set();
    for (const ref of crossReferences) {
      if (ref.similarity < SIMILARITY_JOIN_THRESHOLD) continue;
      for (const story of this.stories) {
        if (story.archived) continue;
        const inStory = story.posts.some(
          (p) => p.channel === ref.channel && p.messageId === ref.messageId
        );
        if (inStory) candidateStoryIds.add(story.id);
      }
    }

    if (candidateStoryIds.size > 0) {
      // Join the most recently active story among candidates
      const candidateStories = this.stories.filter((s) => candidateStoryIds.has(s.id));
      candidateStories.sort((a, b) => b.lastSeen - a.lastSeen);
      const story = candidateStories[0];

      // Avoid duplicates
      if (!story.posts.some((p) => p.channel === channel && p.messageId === messageId)) {
        story.posts.push({ channel, messageId, similarity: 1.0, addedAt: now });
        story.lastSeen = now;
        story.postCount = story.posts.length;
        story.channels = [...new Set(story.posts.map((p) => p.channel))];
        if (category === "ALERT") story.hasAlert = true;
      }

      saveStories(this.stories);
      console.log(`[Stories] Post ${channel}:${messageId} joined story "${story.title}" (${story.postCount} posts, ${story.channels.length} channels)`);
      return story.id;
    }

    // If this post has cross-refs with high similarity but no existing story, start one
    const strongRefs = crossReferences.filter((r) => r.similarity >= SIMILARITY_JOIN_THRESHOLD);
    if (strongRefs.length > 0) {
      const storyId = randomBytes(6).toString("hex");
      const title = text.slice(0, 80).replace(/\n/g, " ").trim();
      const newStory = {
        id: storyId,
        title,
        topic,
        firstSeen: now,
        lastSeen: now,
        postCount: 1 + strongRefs.length,
        hasAlert: category === "ALERT",
        archived: false,
        channels: [...new Set([channel, ...strongRefs.map((r) => r.channel)])],
        posts: [
          { channel, messageId, similarity: 1.0, addedAt: now },
          ...strongRefs.slice(0, 4).map((r) => ({
            channel: r.channel,
            messageId: r.messageId,
            similarity: r.similarity,
            addedAt: now,
          })),
        ],
      };
      this.stories.push(newStory);
      saveStories(this.stories);
      console.log(`[Stories] New story "${title}" — ${newStory.channels.length} channels (${category})`);
      return storyId;
    }

    return null;
  }

  /**
   * Returns active stories sorted by last activity, with at least MIN_POSTS_FOR_STORY posts.
   */
  getActive() {
    return this.stories
      .filter((s) => !s.archived && s.postCount >= MIN_POSTS_FOR_STORY)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 50);
  }

  _pruneOld(now) {
    let changed = false;
    for (const story of this.stories) {
      if (!story.archived && now - story.lastSeen > STORY_TTL_MS) {
        story.archived = true;
        changed = true;
      }
    }
    // Keep at most 200 stories in memory (archived + active)
    if (this.stories.length > 200) {
      this.stories = this.stories.slice(-200);
      changed = true;
    }
    if (changed) saveStories(this.stories);
  }
}

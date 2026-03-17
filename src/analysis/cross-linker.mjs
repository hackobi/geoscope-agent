// Cross-reference finder using vector similarity

const SIMILARITY_THRESHOLD = 0.65;
const MAX_RESULTS = 5;

export class CrossLinker {
  constructor(vectorStore) {
    this.store = vectorStore;
  }

  async findRelated(text, currentChannel) {
    if (!this.store || !this.store.isReady()) return [];

    try {
      const results = await this.store.search(text, MAX_RESULTS + 3);

      // Filter and prioritize cross-channel matches
      const related = results
        .filter(
          (r) => r._distance !== undefined && 1 - r._distance >= SIMILARITY_THRESHOLD
        )
        .map((r) => ({
          channel: r.channel,
          messageId: r.messageId,
          topic: r.topic,
          similarity: 1 - r._distance,
          text: (r.text || "").slice(0, 200),
          timestamp: r.timestamp,
        }))
        // Sort: cross-channel first, then by similarity
        .sort((a, b) => {
          const aCross = a.channel !== currentChannel ? 1 : 0;
          const bCross = b.channel !== currentChannel ? 1 : 0;
          if (aCross !== bCross) return bCross - aCross;
          return b.similarity - a.similarity;
        })
        .slice(0, MAX_RESULTS);

      return related;
    } catch (err) {
      console.warn("Cross-link search failed:", err.message);
      return [];
    }
  }
}

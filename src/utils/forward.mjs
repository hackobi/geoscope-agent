// Forward source resolver — extracts attribution from forwarded Telegram messages

import { Api } from "telegram";

const entityCache = new Map();

export async function resolveForwardSource(client, fwdFrom) {
  if (!fwdFrom) return null;

  let name = fwdFrom.fromName || null;
  let username = null;
  let channelId = null;

  // Try to resolve entity if we have a fromId but no name
  if (fwdFrom.fromId) {
    const peerId = fwdFrom.fromId;
    if (peerId instanceof Api.PeerChannel) {
      channelId = peerId.channelId.toString();
    } else if (peerId instanceof Api.PeerUser) {
      channelId = peerId.userId.toString();
    }

    if (channelId && !name) {
      // Check cache first
      if (entityCache.has(channelId)) {
        const cached = entityCache.get(channelId);
        name = cached.name;
        username = cached.username;
      } else {
        try {
          const entity = await client.getEntity(fwdFrom.fromId);
          name = entity.title || entity.firstName || entity.username || null;
          username = entity.username || null;
          entityCache.set(channelId, { name, username });
        } catch {
          // Entity lookup failed (private channel, deleted, etc.) — silent fallback
        }
      }
    }
  }

  if (!name) return null;

  const channelPost = fwdFrom.channelPost || null;

  // Build t.me URL
  let tmeUrl = null;
  if (username && channelPost) {
    tmeUrl = `https://t.me/${username}/${channelPost}`;
  } else if (channelId && channelPost) {
    tmeUrl = `https://t.me/c/${channelId}/${channelPost}`;
  }

  return { name, username, channelPost, tmeUrl };
}

// SuperColony authentication and agent registration

import { COLONY_URL } from "../config.mjs";
import { getDemos, getAddress } from "./demos.mjs";

let authHeaders = {};
let refreshTimer;

export function getAuthHeaders() {
  return authHeaders;
}

export async function authenticate() {
  const demos = getDemos();
  const address = getAddress();

  try {
    const challengeRes = await fetch(
      `${COLONY_URL}/api/auth/challenge?address=${address}`
    );
    if (!challengeRes.ok) {
      throw new Error(`Challenge request failed: ${challengeRes.status} ${challengeRes.statusText}`);
    }
    const { challenge, message } = await challengeRes.json();
    const sig = await demos.signMessage(message);

    const verifyRes = await fetch(`${COLONY_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        challenge,
        signature: sig.data,
        algorithm: sig.type || "ed25519",
      }),
    });
    if (!verifyRes.ok) {
      throw new Error(`Verify request failed: ${verifyRes.status} ${verifyRes.statusText}`);
    }
    const { token } = await verifyRes.json();

    authHeaders = { Authorization: `Bearer ${token}` };
    console.log("Authenticated with SuperColony");
    return true;
  } catch (err) {
    console.error("Authentication failed:", err.message);
    return false;
  }
}

export async function registerAgent() {
  try {
    const res = await fetch(`${COLONY_URL}/api/agents/register`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "geoscope",
        description:
          "AI-powered geopolitical analyst that monitors multiple Telegram channels, cross-references events across domains, and publishes verified analytical observations",
        specialties: ["geopolitics", "intelligence", "analysis", "cross-domain"],
      }),
    });

    if (res.ok) {
      console.log("Agent registered");
    } else if (res.status === 409) {
      console.log("Agent already registered");
    } else {
      console.warn(`Agent registration failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn("Registration skipped:", err.message);
  }
}

export function startAuthRefresh() {
  // Refresh every 20 hours
  refreshTimer = setInterval(async () => {
    console.log("Refreshing SuperColony authentication...");
    await authenticate();
  }, 20 * 60 * 60 * 1000);
}

export function stopAuthRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RPC_URL = process.env.DEMOS_RPC_URL || "https://node2.demos.sh/";
const MNEMONIC = process.env.DEMOS_MNEMONIC;

// Singleton SDK + Identities instance
let demosInstance: unknown = null;
let identitiesInstance: unknown = null;
let ready = false;

interface DemosSDK {
  connect: (url: string) => Promise<void>;
  connectWallet: (mnemonic: string) => Promise<void>;
}

interface IdentitiesSDK {
  getIdentities: (demos: unknown, call: string, address: string) => Promise<unknown>;
  getWeb2Identities: (demos: unknown, address: string) => Promise<unknown>;
  getDemosIdsByTwitter: (demos: unknown, username: string, userId?: string) => Promise<unknown>;
  getDemosIdsByTelegram: (demos: unknown, username: string, userId?: string) => Promise<unknown>;
  getDemosIdsByGithub: (demos: unknown, username: string, userId?: string) => Promise<unknown>;
  getDemosIdsByDiscord: (demos: unknown, username: string, userId?: string) => Promise<unknown>;
}

async function getSDK(): Promise<{ demos: DemosSDK; ids: IdentitiesSDK } | null> {
  if (ready && demosInstance && identitiesInstance) {
    return { demos: demosInstance as DemosSDK, ids: identitiesInstance as IdentitiesSDK };
  }

  if (!MNEMONIC) {
    console.error("DEMOS_MNEMONIC not set — identity resolution unavailable");
    return null;
  }

  try {
    const { Demos } = await import("@kynesyslabs/demosdk/websdk");
    const { Identities } = await import("@kynesyslabs/demosdk/abstraction");

    const d = new (Demos as new () => DemosSDK)();
    await d.connect(RPC_URL);
    await d.connectWallet(MNEMONIC);

    const ids = new (Identities as new () => IdentitiesSDK)();

    demosInstance = d;
    identitiesInstance = ids;
    ready = true;
    return { demos: d, ids };
  } catch (err) {
    console.error("Identity SDK init failed:", err);
    ready = false;
    return null;
  }
}

interface IdentityResponse {
  web2?: Record<string, unknown>;
  xm?: Record<string, unknown>;
  pqc?: Record<string, unknown>;
  ud?: unknown[];
}

function parseIdentityResult(raw: unknown): IdentityResponse {
  const r = raw as { response?: { data?: IdentityResponse } & IdentityResponse };
  const data = r?.response?.data || r?.response || {};
  return {
    web2: (data as IdentityResponse).web2 || {},
    xm: (data as IdentityResponse).xm || {},
    pqc: (data as IdentityResponse).pqc || {},
    ud: (data as IdentityResponse).ud || [],
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const address = searchParams.get("address");
  const twitter = searchParams.get("twitter");
  const telegram = searchParams.get("telegram");
  const github = searchParams.get("github");
  const discord = searchParams.get("discord");

  try {
    const sdk = await getSDK();
    if (!sdk) {
      return NextResponse.json(
        { error: "Identity SDK unavailable — check DEMOS_MNEMONIC", available: false },
        { status: 500 },
      );
    }

    const { demos, ids } = sdk;

    // Resolve address → linked identities
    if (address) {
      const raw = await ids.getIdentities(demos, "getIdentities", address);
      const parsed = parseIdentityResult(raw);

      const hasLinks =
        Object.keys(parsed.web2 || {}).length > 0 ||
        Object.keys(parsed.xm || {}).length > 0 ||
        Object.keys(parsed.pqc || {}).length > 0 ||
        (parsed.ud || []).length > 0;

      return NextResponse.json({
        address,
        ...parsed,
        hasLinks,
      });
    }

    // Reverse lookups: social handle → Demos addresses
    if (twitter) {
      const result = await ids.getDemosIdsByTwitter(demos, twitter);
      const addresses = Array.isArray(result) ? result : [];
      return NextResponse.json({ platform: "twitter", handle: twitter, addresses });
    }

    if (telegram) {
      const result = await ids.getDemosIdsByTelegram(demos, telegram);
      const addresses = Array.isArray(result) ? result : [];
      return NextResponse.json({ platform: "telegram", handle: telegram, addresses });
    }

    if (github) {
      const result = await ids.getDemosIdsByGithub(demos, github);
      const addresses = Array.isArray(result) ? result : [];
      return NextResponse.json({ platform: "github", handle: github, addresses });
    }

    if (discord) {
      const result = await ids.getDemosIdsByDiscord(demos, discord);
      const addresses = Array.isArray(result) ? result : [];
      return NextResponse.json({ platform: "discord", handle: discord, addresses });
    }

    return NextResponse.json(
      { error: "Provide ?address=, ?twitter=, ?telegram=, ?github=, or ?discord=" },
      { status: 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Identity query failed";
    ready = false;
    demosInstance = null;
    identitiesInstance = null;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

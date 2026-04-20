import { NextResponse } from "next/server";
import { parseLogStats } from "@/lib/geoscope";

export const dynamic = "force-dynamic";

const RPC_URL = process.env.DEMOS_RPC_URL || "https://node2.demos.sh/";

// Cache the Demos instance across requests (singleton)
let demosInstance: unknown = null;
let demosReady = false;

async function getDemos() {
  if (demosReady && demosInstance) return demosInstance;
  try {
    const { Demos } = await import("@kynesyslabs/demosdk/websdk");
    const d = new (Demos as new () => unknown)();
    await (d as { connect: (url: string) => Promise<void> }).connect(RPC_URL);
    demosInstance = d;
    demosReady = true;
    return d;
  } catch (err) {
    console.error("Demos SDK init failed:", err);
    demosReady = false;
    return null;
  }
}

export async function GET() {
  const { wallet } = parseLogStats();

  if (!wallet) {
    return NextResponse.json(
      { error: "No wallet address found", balance: null },
      { status: 400 }
    );
  }

  try {
    const demos = await getDemos();
    if (!demos) {
      return NextResponse.json({ error: "SDK unavailable", balance: null }, { status: 500 });
    }

    // Strip 0x prefix — SDK expects raw hex address
    const addr = wallet.startsWith("0x") ? wallet.slice(2) : wallet;
    const info = await (demos as { getAddressInfo: (a: string) => Promise<{ balance?: unknown }> }).getAddressInfo(addr);
    const balance = Number(info?.balance ?? 0);

    return NextResponse.json({ balance, wallet });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Balance check failed";
    // Reset connection on error so next request retries
    demosReady = false;
    demosInstance = null;
    return NextResponse.json({ error: message, balance: null }, { status: 500 });
  }
}

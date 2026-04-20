import { NextResponse } from "next/server";
import { parseLogStats } from "@/lib/geoscope";

export const dynamic = "force-dynamic";

const FAUCET_URL = "https://faucetbackend.demos.sh/api/request";

export async function POST() {
  const { wallet } = parseLogStats();

  if (!wallet) {
    return NextResponse.json(
      { error: "No wallet address found — is the agent running?" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet }),
    });

    const data = await res.json();

    if (!res.ok || data.status >= 400) {
      return NextResponse.json(
        { error: data.body?.message || data.message || "Faucet request failed" },
        { status: res.status }
      );
    }

    const body = data.body || data;
    return NextResponse.json({
      txHash: body.txHash,
      amount: body.amount,
      message: body.message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Faucet request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

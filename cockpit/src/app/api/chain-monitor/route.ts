import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RPC_URL = process.env.DEMOS_RPC_URL || "https://node2.demos.sh/";
const BLOCK_HISTORY = 10; // last N blocks for rate calculation

// Singleton SDK connection
let demosInstance: unknown = null;
let demosReady = false;

interface DemosSDK {
  connect: (url: string) => Promise<void>;
  getLastBlockNumber: () => Promise<number>;
  getBlocks: (start: number, limit: number) => Promise<BlockData[]>;
  getMempool: () => Promise<MempoolTx[]>;
}

interface BlockData {
  number: number;
  hash: string;
  content: {
    ordered_transactions: unknown[];
    timestamp: number;
    previousHash: string;
  };
  proposer: string;
  status: string;
}

interface MempoolTx {
  hash: string;
  timestamp: string;
  content: {
    type: string;
    from: string;
    to: string;
    amount: number;
  };
}

async function getDemos(): Promise<DemosSDK | null> {
  if (demosReady && demosInstance) return demosInstance as DemosSDK;
  try {
    const { Demos } = await import("@kynesyslabs/demosdk/websdk");
    const d = new (Demos as new () => DemosSDK)();
    await d.connect(RPC_URL);
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
  try {
    const demos = await getDemos();
    if (!demos) {
      return NextResponse.json({ error: "SDK unavailable" }, { status: 500 });
    }

    const blockNumber = await demos.getLastBlockNumber();

    // Fetch recent blocks for rate calculation
    const startBlock = Math.max(0, blockNumber - BLOCK_HISTORY);
    const rawBlocks = await demos.getBlocks(startBlock, BLOCK_HISTORY);
    const blocks = (rawBlocks || []).map((b: BlockData) => ({
      number: b.number,
      hash: b.hash?.slice(0, 16),
      timestamp: b.content?.timestamp || 0,
      txCount: b.content?.ordered_transactions?.length || 0,
      proposer: b.proposer?.slice(0, 12),
    }));

    // Calculate block production rate (blocks per minute)
    let blockRate = 0;
    if (blocks.length >= 2) {
      const timestamps = blocks.map((b: { timestamp: number }) => b.timestamp).filter((t: number) => t > 0).sort((a: number, b: number) => a - b);
      if (timestamps.length >= 2) {
        const spanSecs = timestamps[timestamps.length - 1] - timestamps[0];
        if (spanSecs > 0) {
          blockRate = Math.round(((timestamps.length - 1) / spanSecs) * 60 * 10) / 10;
        }
      }
    }

    // Fetch mempool
    let mempoolSize = 0;
    let mempoolTypes: Record<string, number> = {};
    try {
      const mempool = await demos.getMempool();
      const txs = Array.isArray(mempool) ? mempool : [];
      mempoolSize = txs.length;
      // Count by transaction type
      for (const tx of txs.slice(0, 500)) { // sample first 500 for type counts
        const t = (tx as MempoolTx)?.content?.type || "unknown";
        mempoolTypes[t] = (mempoolTypes[t] || 0) + 1;
      }
      // Scale up if we only sampled
      if (txs.length > 500) {
        const scale = txs.length / 500;
        for (const key of Object.keys(mempoolTypes)) {
          mempoolTypes[key] = Math.round(mempoolTypes[key] * scale);
        }
      }
    } catch {
      // mempool query can fail, non-critical
    }

    return NextResponse.json({
      blockNumber,
      blockRate,
      blocks,
      mempoolSize,
      mempoolTypes,
      rpcNode: RPC_URL,
      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chain monitor failed";
    demosReady = false;
    demosInstance = null;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

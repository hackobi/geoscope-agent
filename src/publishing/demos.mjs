// Demos blockchain connection, DAHR attestation, and publishing

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk";
import { RPC_URL, MNEMONIC, DRY_RUN } from "../config.mjs";
import { encodePost } from "../utils/hive.mjs";

let demos;
let agentAddress;

export async function connectDemos() {
  demos = new Demos();
  await demos.connect(RPC_URL);
  await demos.connectWallet(MNEMONIC);
  agentAddress = demos.getAddress();
  console.log(`Connected to Demos as ${agentAddress}`);
  try {
    const info = await demos.getAddressInfo(agentAddress);
    console.log(`  Balance: ${info?.balance || 0} DEM`);
  } catch (err) {
    console.warn(`  Could not fetch balance: ${err.message}`);
  }
  return { demos, agentAddress };
}

export function getAddress() {
  return agentAddress;
}

export function getDemos() {
  return demos;
}

export async function attestUrl(url) {
  if (DRY_RUN) {
    console.log(`  [DRY_RUN] Would attest: ${url}`);
    return { url, responseHash: "dry-run", txHash: "dry-run", timestamp: Date.now() };
  }

  try {
    const dahr = await demos.web2.createDahr();
    const proxyResponse = await dahr.startProxy({ url, method: "GET" });
    return {
      url,
      responseHash: proxyResponse.responseHash,
      txHash: proxyResponse.txHash,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.warn(`DAHR attestation failed for ${url}:`, err.message);
    return null;
  }
}

export async function publish(payload) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Would publish [${payload.cat}]: ${payload.text.slice(0, 60)}...`);
    return "dry-run-tx";
  }

  const bytes = encodePost({ v: 1, ...payload });
  const tx = await DemosTransactions.store(bytes, demos);
  const validity = await DemosTransactions.confirm(tx, demos);
  await DemosTransactions.broadcast(validity, demos);

  const txHash = tx.hash || tx.txHash || "unknown";
  console.log(`Published [${payload.cat}]: ${payload.text.slice(0, 60)}...`);
  console.log(`  tx: https://scan.demos.network/transactions/${txHash}`);
  return txHash;
}

import { Address, xdr, scValToNative, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-rpc.creit.tech/";
const POOL_ID = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS";
const BACKSTOP_ID = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";
const USER = "GDD7N6ACZHGW2ELKV267HLGYBPWOLW3R3RDP4CWOTVZQHOVNVBOKPT4J";

async function main() {
  const latestResp = await rpcCall("getLatestLedger");
  const latestLedger = latestResp.result.sequence;
  console.log("Latest ledger:", latestLedger);

  const userPubKeyBuf = Buffer.from(Keypair.fromPublicKey(USER).rawPublicKey());
  console.log("User pubkey hex:", userPubKeyBuf.toString("hex"));

  // Find oldest available ledger
  const testResponse = await rpcCall("getEvents", {
    startLedger: 1,
    filters: [{ type: "contract", contractIds: [POOL_ID] }],
    pagination: { limit: 1 },
  });
  const oldestLedger = extractOldestLedger(testResponse) || latestLedger - 17280;
  console.log(`Retention window: ${oldestLedger} - ${latestLedger} (${latestLedger - oldestLedger} ledgers)\n`);

  // Scan ALL transactions in the retention window
  // Check each transaction's XDR for user pubkey bytes
  console.log("Scanning ALL transactions for user pubkey bytes...");
  console.log("This will take a while - checking every transaction in the window.\n");

  let scanStart = oldestLedger + 50;
  let cursor: string | undefined;
  let totalTxScanned = 0;
  let matchingTxs: any[] = [];
  let lastProgressLedger = scanStart;

  while (scanStart < latestLedger) {
    const params: any = {
      pagination: { limit: 200 },
    };
    if (cursor) {
      params.pagination.cursor = cursor;
    } else {
      params.startLedger = scanStart;
    }

    const resp = await rpcCall("getTransactions", params);

    // Debug first response
    if (totalTxScanned === 0 && !cursor) {
      console.log("First response keys:", Object.keys(resp.result || {}));
      console.log("Transactions in first batch:", resp.result?.transactions?.length ?? "N/A");
      if (resp.error) console.log("Error:", JSON.stringify(resp.error));
    }

    if (resp.error) {
      const newOldest = extractOldestLedger(resp);
      if (newOldest && !cursor) {
        scanStart = newOldest;
        continue;
      }
      console.error("RPC error:", resp.error.message || JSON.stringify(resp.error));
      break;
    }

    const txs = resp.result?.transactions || [];
    totalTxScanned += txs.length;

    for (const tx of txs) {
      // Use Buffer.indexOf for fast binary search (avoids expensive hex conversion)
      const envBuf = tx.envelopeXdr ? Buffer.from(tx.envelopeXdr, "base64") : Buffer.alloc(0);
      const metaBuf = tx.resultMetaXdr ? Buffer.from(tx.resultMetaXdr, "base64") : Buffer.alloc(0);

      const userInEnvelope = envBuf.indexOf(userPubKeyBuf) !== -1;
      const userInMeta = metaBuf.indexOf(userPubKeyBuf) !== -1;

      if (userInEnvelope || userInMeta) {
        matchingTxs.push({
          hash: tx.hash,
          ledger: tx.ledger,
          createdAt: tx.createdAt,
          status: tx.status,
          userInEnvelope,
          userInMeta,
          envelopeXdr: tx.envelopeXdr,
          resultMetaXdr: tx.resultMetaXdr,
        });
      }
    }

    // Progress reporting
    const currentLedger = txs.length > 0 ? txs[txs.length - 1].ledger : scanStart;
    if (currentLedger - lastProgressLedger > 2000) {
      const pct = Math.round(((currentLedger - oldestLedger) / (latestLedger - oldestLedger)) * 100);
      console.log(`  Progress: ${pct}% (ledger ${currentLedger}, ${totalTxScanned} txs scanned, ${matchingTxs.length} matches)`);
      lastProgressLedger = currentLedger;
    }

    if (txs.length < 200) {
      if (txs.length > 0) {
        scanStart = txs[txs.length - 1].ledger + 1;
      } else {
        scanStart += 200;
      }
      cursor = undefined;
    } else {
      cursor = resp.result.cursor || txs[txs.length - 1].id;
    }
  }

  console.log(`\nScan complete: ${totalTxScanned} transactions scanned`);
  console.log(`Transactions involving BOTH user AND pool: ${matchingTxs.length}\n`);

  // Decode each matching transaction's events
  for (const tx of matchingTxs) {
    console.log("=".repeat(70));
    console.log(`TX: ${tx.hash}`);
    console.log(`Ledger: ${tx.ledger} | Created: ${tx.createdAt} | Status: ${tx.status}`);
    console.log(`User in envelope: ${tx.userInEnvelope} | User in meta: ${tx.userInMeta}`);

    // Decode events from resultMeta
    try {
      const meta = xdr.TransactionMeta.fromXDR(tx.resultMetaXdr, "base64");
      const v3 = meta.v3();
      const sorobanMeta = v3?.sorobanMeta();
      if (sorobanMeta) {
        const events = sorobanMeta.events();
        console.log(`Events in tx: ${events.length}`);
        for (let i = 0; i < events.length; i++) {
          const evt = events[i];
          let contractId = "none";
          try {
            const rawId = evt.contractId();
            if (rawId) {
              contractId = Address.contract(Buffer.from(rawId as any)).toString();
            }
          } catch { contractId = "unknown"; }
          const body = evt.body().v0();
          const topics = body.topics().map((t: any) => {
            try { return scValToNative(t); } catch { return t.toXDR("base64"); }
          });
          let data: any;
          try { data = scValToNative(body.data()); } catch { data = body.data().toXDR("base64"); }

          const isPool = contractId === POOL_ID;
          const isBackstop = contractId === BACKSTOP_ID;
          const label = isPool ? " [POOL]" : isBackstop ? " [BACKSTOP]" : "";

          console.log(`  Event ${i}${label}: contract=${contractId}`);
          console.log(`    Topics: ${stringify(topics)}`);
          console.log(`    Data: ${stringify(data)}`);
        }
      }
    } catch (err: any) {
      console.log(`  Error decoding meta: ${err.message}`);
      try {
        const meta2 = xdr.TransactionMeta.fromXDR(tx.resultMetaXdr, "base64");
        console.log(`  Meta switch: ${meta2.switch()}`);
      } catch {}
    }
    console.log();
  }
}

// --- Helpers ---

function stringify(obj: any): string {
  return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function extractOldestLedger(response: any): number | null {
  if (response.error?.data?.oldestLedger) return response.error.data.oldestLedger;
  const msg = response.error?.message || "";
  const match = msg.match(/(\d+)\s*-\s*(\d+)/);
  if (match) return parseInt(match[1]);
  return null;
}

async function rpcCall(method: string, params: any = {}): Promise<any> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

main().catch(console.error);

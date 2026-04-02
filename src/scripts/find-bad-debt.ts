import { Address, xdr, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-rpc.creit.tech/";
const POOL_ID = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS";
const USER = "GDD7N6ACZHGW2ELKV267HLGYBPWOLW3R3RDP4CWOTVZQHOVNVBOKPT4J";

async function main() {
  const latestResp = await rpcCall("getLatestLedger");
  const latestLedger = latestResp.result.sequence;
  console.log("Latest ledger:", latestLedger);

  // ~24h ago: 17280 ledgers at 5s each
  const startLedger = latestLedger - 17280;

  // Encode "bad_debt" symbol as XDR for the topic filter
  const badDebtSymbol = nativeToScVal("bad_debt", { type: "symbol" });
  const badDebtXdr = badDebtSymbol.toXDR("base64");
  console.log(`Searching for bad_debt events from pool ${POOL_ID}`);
  console.log(`Ledger range: ${startLedger} - ${latestLedger}\n`);

  let cursor: string | undefined;
  let allEvents: any[] = [];
  let page = 0;

  while (true) {
    const params: any = {
      filters: [
        {
          type: "contract",
          contractIds: [POOL_ID],
          topics: [[badDebtXdr, "*", "*"]],
        },
      ],
      pagination: { limit: 200 },
    };

    if (cursor) {
      params.pagination.cursor = cursor;
    } else {
      params.startLedger = startLedger;
    }

    const resp = await rpcCall("getEvents", params);

    if (resp.error) {
      console.error("RPC error:", JSON.stringify(resp.error));
      // Try adjusting start ledger if out of retention
      const oldest = extractOldestLedger(resp);
      if (oldest && !cursor) {
        console.log(`Adjusting start to oldest available: ${oldest}`);
        params.startLedger = oldest;
        const retryResp = await rpcCall("getEvents", params);
        if (retryResp.error) {
          console.error("Retry error:", JSON.stringify(retryResp.error));
          break;
        }
        processEvents(retryResp, allEvents);
      }
      break;
    }

    processEvents(resp, allEvents);

    const events = resp.result?.events || [];
    page++;
    console.log(`Page ${page}: ${events.length} events`);

    if (events.length < 200) break;
    cursor = resp.result.cursor || events[events.length - 1].id;
  }

  console.log(`\nTotal bad_debt events found: ${allEvents.length}\n`);

  // Filter for our user
  const userEvents = allEvents.filter((e) => e.userAddress === USER);
  console.log(`Bad debt events for ${USER}: ${userEvents.length}`);

  // Show all events
  for (const evt of allEvents) {
    console.log("=".repeat(70));
    console.log(`Ledger: ${evt.ledger} | TX: ${evt.txHash}`);
    console.log(`User: ${evt.userAddress}`);
    console.log(`Asset: ${evt.assetAddress}`);
    console.log(`d_tokens: ${evt.dTokens}`);
    console.log(`Raw topics: ${stringify(evt.rawTopics)}`);
    console.log(`Raw data: ${stringify(evt.rawData)}`);
    if (evt.userAddress === USER) {
      console.log(`  >>> MATCHES TARGET USER <<<`);
    }
  }

  if (allEvents.length === 0) {
    console.log("No bad_debt events found in the last 24h for this pool.");
    console.log("\nLet's also check for fill_auction and new_auction to see if there's liquidation activity...\n");
    await searchAuctionEvents(startLedger, latestLedger);
  }
}

async function searchAuctionEvents(startLedger: number, latestLedger: number) {
  for (const eventType of ["fill_auction", "new_auction"]) {
    const symbol = nativeToScVal(eventType, { type: "symbol" });
    const symbolXdr = symbol.toXDR("base64");

    const params: any = {
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [POOL_ID],
          topics: [[symbolXdr, "*", "*"]],
        },
      ],
      pagination: { limit: 10 },
    };

    const resp = await rpcCall("getEvents", params);
    const events = resp.result?.events || [];
    console.log(`${eventType} events in last 24h: ${events.length}${events.length === 10 ? "+" : ""}`);

    for (const evt of events) {
      const topics = evt.topic.map((t: string) => {
        try { return scValToNative(xdr.ScVal.fromXDR(t, "base64")); } catch { return t; }
      });
      let data: any;
      try { data = scValToNative(xdr.ScVal.fromXDR(evt.value, "base64")); } catch { data = evt.value; }
      console.log(`  Ledger ${evt.ledger}: topics=${stringify(topics)}`);
    }
    console.log();
  }
}

function processEvents(resp: any, allEvents: any[]) {
  const events = resp.result?.events || [];
  for (const evt of events) {
    const topics = evt.topic.map((t: string) => {
      try { return scValToNative(xdr.ScVal.fromXDR(t, "base64")); } catch { return t; }
    });
    let data: any;
    try { data = scValToNative(xdr.ScVal.fromXDR(evt.value, "base64")); } catch { data = evt.value; }

    allEvents.push({
      ledger: evt.ledger,
      txHash: evt.txHash,
      userAddress: typeof topics[0] === "string" && topics.length > 1 ? topics[0] : null, // topics[1] in original = topics[0] after removing event name
      assetAddress: topics.length > 1 ? topics[1] : null,
      dTokens: data,
      rawTopics: topics,
      rawData: data,
    });
  }
}

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

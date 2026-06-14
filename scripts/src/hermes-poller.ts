#!/usr/bin/env node
/**
 * Hermes Local Poller
 *
 * Runs on your local PC. Polls the Railway webhook queue, sends each payload
 * to your local Hermes agent, then posts the reply back to Railway.
 *
 * Usage:
 *   RAILWAY_URL=https://your-app.railway.app \
 *   POLL_API_KEY=your-secret-key \
 *   HERMES_URL=http://localhost:8644 \
 *   npx ts-node scripts/src/hermes-poller.ts
 *
 * Or compile first and run with node:
 *   npx tsc --project scripts/tsconfig.json
 *   node scripts/dist/hermes-poller.js
 *
 * Environment variables:
 *   RAILWAY_URL      - Base URL of your Railway-deployed app (no trailing slash)
 *   POLL_API_KEY     - Secret key set on Railway to protect the /poll endpoint
 *   HERMES_URL       - Local Hermes gateway URL (default: http://localhost:8644)
 *   POLL_INTERVAL_MS - How often to poll in ms (default: 3000)
 *   HERMES_ROUTE     - Hermes webhook route name (default: zernio)
 */

const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, "");
const POLL_API_KEY = process.env.POLL_API_KEY;
const HERMES_URL = (process.env.HERMES_URL ?? "http://localhost:8644").replace(/\/$/, "");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const HERMES_ROUTE = process.env.HERMES_ROUTE ?? "zernio";

if (!RAILWAY_URL) {
  console.error("❌  RAILWAY_URL is required. Set it to your Railway app URL.");
  process.exit(1);
}

if (!POLL_API_KEY) {
  console.warn("⚠️  POLL_API_KEY not set — poll endpoint is unprotected.");
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  ...(POLL_API_KEY ? { "x-api-key": POLL_API_KEY } : {}),
};

interface WebhookItem {
  id: number;
  payload: string;
  source: string;
  status: string;
  createdAt: string;
}

async function pollOnce(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${RAILWAY_URL}/api/webhooks/poll?limit=10`, { headers });
  } catch (err) {
    console.error("  poll failed (network):", (err as Error).message);
    return;
  }

  if (!res.ok) {
    console.error(`  poll failed: HTTP ${res.status}`);
    return;
  }

  const { items } = (await res.json()) as { items: WebhookItem[] };

  if (items.length === 0) return;

  console.log(`  📥 ${items.length} webhook(s) received`);

  for (const item of items) {
    await processItem(item);
  }
}

async function processItem(item: WebhookItem): Promise<void> {
  console.log(`  → processing id=${item.id}`);

  let hermesReply: string | null = null;
  let finalStatus: "replied" | "failed" = "replied";

  try {
    const payload = JSON.parse(item.payload) as Record<string, unknown>;

    const hermesRes = await fetch(
      `${HERMES_URL}/webhooks/${HERMES_ROUTE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!hermesRes.ok) {
      console.warn(`    hermes returned HTTP ${hermesRes.status} for id=${item.id}`);
      finalStatus = "failed";
    } else {
      const body = await hermesRes.text();
      hermesReply = body;
      console.log(`    ✅ hermes replied for id=${item.id}`);
    }
  } catch (err) {
    console.error(`    ❌ hermes call failed for id=${item.id}:`, (err as Error).message);
    finalStatus = "failed";
  }

  try {
    const replyRes = await fetch(`${RAILWAY_URL}/api/webhooks/reply/${item.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reply: hermesReply, status: finalStatus }),
    });

    if (!replyRes.ok) {
      console.error(`    failed to post reply for id=${item.id}: HTTP ${replyRes.status}`);
    }
  } catch (err) {
    console.error(`    failed to post reply for id=${item.id}:`, (err as Error).message);
  }
}

async function main(): Promise<void> {
  console.log("════════════════════════════════════════");
  console.log("  Hermes Local Poller");
  console.log(`  Railway : ${RAILWAY_URL}`);
  console.log(`  Hermes  : ${HERMES_URL}`);
  console.log(`  Route   : ${HERMES_ROUTE}`);
  console.log(`  Interval: ${POLL_INTERVAL_MS}ms`);
  console.log("════════════════════════════════════════");
  console.log("  Polling started. Press Ctrl+C to stop.\n");

  // Run immediately on start, then on interval
  await pollOnce();

  setInterval(() => {
    pollOnce().catch((err: Error) => console.error("  poll error:", err.message));
  }, POLL_INTERVAL_MS);
}

main().catch((err: Error) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

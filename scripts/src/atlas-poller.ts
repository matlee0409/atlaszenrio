#!/usr/bin/env node
/**
 * Atlas Local Poller
 *
 * Runs on your local PC. Polls the Railway webhook queue, sends each payload
 * to your local Atlas agent, then posts the reply back to Railway.
 *
 * Usage:
 *   RAILWAY_URL=https://your-app.railway.app \
 *   POLL_API_KEY=atlas_yourRandomStringHere \
 *   ATLAS_AGENT_ID=your-agent-id \
 *   ATLAS_URL=http://localhost:8644 \
 *   pnpm --filter @workspace/scripts run atlas-poller
 *
 * Environment variables:
 *   RAILWAY_URL      - Base URL of your Railway-deployed app (no trailing slash)
 *   POLL_API_KEY     - Must start with "atlas_" followed by a random string
 *   ATLAS_AGENT_ID   - Your Atlas agent ID (set same value on Railway)
 *   ATLAS_URL        - Local Atlas gateway URL (default: http://localhost:8644)
 *   POLL_INTERVAL_MS - How often to poll in ms (default: 3000)
 *   ATLAS_ROUTE      - Atlas webhook route name (default: zernio)
 */

const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, "");
const POLL_API_KEY = process.env.POLL_API_KEY;
const ATLAS_AGENT_ID = process.env.ATLAS_AGENT_ID;
const ATLAS_URL = (process.env.ATLAS_URL ?? "http://localhost:8644").replace(/\/$/, "");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const ATLAS_ROUTE = process.env.ATLAS_ROUTE ?? "zernio";

if (!RAILWAY_URL) {
  console.error("❌  RAILWAY_URL is required.");
  process.exit(1);
}

if (!POLL_API_KEY) {
  console.error("❌  POLL_API_KEY is required.");
  process.exit(1);
}

if (!POLL_API_KEY.startsWith("atlas_")) {
  console.error("❌  POLL_API_KEY must start with 'atlas_' (e.g. atlas_abc123...)");
  process.exit(1);
}

if (!ATLAS_AGENT_ID) {
  console.error("❌  ATLAS_AGENT_ID is required.");
  process.exit(1);
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "x-api-key": POLL_API_KEY,
  "x-atlas-agent-id": ATLAS_AGENT_ID,
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
    console.error(`  poll failed: HTTP ${res.status} — ${await res.text()}`);
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

  let atlasReply: string | null = null;
  let finalStatus: "replied" | "failed" = "replied";

  try {
    const payload = JSON.parse(item.payload) as Record<string, unknown>;

    const atlasRes = await fetch(
      `${ATLAS_URL}/webhooks/${ATLAS_ROUTE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!atlasRes.ok) {
      console.warn(`    atlas returned HTTP ${atlasRes.status} for id=${item.id}`);
      finalStatus = "failed";
    } else {
      const body = await atlasRes.text();
      atlasReply = body;
      console.log(`    ✅ atlas replied for id=${item.id}`);
    }
  } catch (err) {
    console.error(`    ❌ atlas call failed for id=${item.id}:`, (err as Error).message);
    finalStatus = "failed";
  }

  try {
    const replyRes = await fetch(`${RAILWAY_URL}/api/webhooks/reply/${item.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reply: atlasReply, status: finalStatus }),
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
  console.log("  Atlas Local Poller");
  console.log(`  Railway  : ${RAILWAY_URL}`);
  console.log(`  Atlas    : ${ATLAS_URL}`);
  console.log(`  Agent ID : ${ATLAS_AGENT_ID}`);
  console.log(`  Route    : ${ATLAS_ROUTE}`);
  console.log(`  Interval : ${POLL_INTERVAL_MS}ms`);
  console.log("════════════════════════════════════════");
  console.log("  Polling started. Press Ctrl+C to stop.\n");

  await pollOnce();

  setInterval(() => {
    pollOnce().catch((err: Error) => console.error("  poll error:", err.message));
  }, POLL_INTERVAL_MS);
}

main().catch((err: Error) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

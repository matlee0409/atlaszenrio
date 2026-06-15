import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { db, webhookQueueTable } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getSigningSecret } from "../lib/secrets.js";

const router: IRouter = Router();

function verifyZernioSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}

function verifyAtlasAuth(req: Request): { ok: boolean; error?: string } {
  const apiKey = process.env.POLL_API_KEY;
  const agentId = process.env.ATLAS_AGENT_ID;

  const providedKey = req.headers["x-api-key"] as string | undefined;
  const providedAgentId = req.headers["x-atlas-agent-id"] as string | undefined;

  if (apiKey) {
    if (!providedKey) {
      return { ok: false, error: "Missing x-api-key" };
    }
    if (!providedKey.startsWith("atlas_")) {
      return { ok: false, error: "Invalid key format — must start with atlas_" };
    }
    if (providedKey !== apiKey) {
      return { ok: false, error: "Unauthorized" };
    }
  }

  if (agentId) {
    if (!providedAgentId) {
      return { ok: false, error: "Missing x-atlas-agent-id" };
    }
    if (providedAgentId !== agentId) {
      return { ok: false, error: "Unknown agent" };
    }
  }

  return { ok: true };
}

router.post("/webhooks/zernio", async (req: Request, res: Response) => {
  const secret = getSigningSecret();

  if (!secret) {
    res.status(503).json({
      error: "Server still initializing — signing secret not ready yet.",
    });
    return;
  }

  const rawBody = (req as any).rawBody as string ?? JSON.stringify(req.body);
  const signature =
    (req.headers["x-zernio-signature"] ?? req.headers["x-late-signature"]) as string | undefined;

  if (!signature) {
    res.status(401).json({ error: "Missing X-Zernio-Signature header" });
    return;
  }

  try {
    const valid = verifyZernioSignature(rawBody, signature, secret);
    if (!valid) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  } catch {
    res.status(401).json({ error: "Signature verification failed" });
    return;
  }

  try {
    const [item] = await db
      .insert(webhookQueueTable)
      .values({
        source: "zernio",
        payload: rawBody,
        signature: signature ?? null,
        status: "pending",
      })
      .returning();

    res.status(202).json({ queued: true, id: item.id });
  } catch (err) {
    console.error("DB insert failed:", err);
    res.status(500).json({ error: "Failed to queue webhook", detail: String(err) });
  }
});

router.get("/webhooks/poll", async (req: Request, res: Response) => {
  const auth = verifyAtlasAuth(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.error });
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 10), 50);

  const items = await db
    .select()
    .from(webhookQueueTable)
    .where(eq(webhookQueueTable.status, "pending"))
    .limit(limit);

  if (items.length > 0) {
    await db
      .update(webhookQueueTable)
      .set({ status: "processing" })
      .where(eq(webhookQueueTable.status, "pending"));

    res.json({ items });
  } else {
    res.json({ items: [] });
  }
});

router.post("/webhooks/reply/:id", async (req: Request, res: Response) => {
  const auth = verifyAtlasAuth(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.error });
    return;
  }

  const id = Number(req.params.id);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { reply, status } = req.body as {
    reply?: string;
    status?: "replied" | "failed";
  };

  await db
    .update(webhookQueueTable)
    .set({
      reply: reply ?? null,
      status: status ?? "replied",
      processedAt: new Date(),
    })
    .where(eq(webhookQueueTable.id, id));

  res.json({ ok: true });
});

router.get("/webhooks/status/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [item] = await db
    .select()
    .from(webhookQueueTable)
    .where(eq(webhookQueueTable.id, id))
    .limit(1);

  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json(item);
});

export default router;

import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { db, webhookQueueTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

router.post("/webhooks/zernio", async (req: Request, res: Response) => {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers["x-zernio-signature"] as string | undefined;

  if (secret && signature) {
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
  }

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
});

router.get("/webhooks/poll", async (req: Request, res: Response) => {
  const apiKey = process.env.POLL_API_KEY;
  const provided = req.headers["x-api-key"] as string | undefined;

  if (apiKey && provided !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
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
  const apiKey = process.env.POLL_API_KEY;
  const provided = req.headers["x-api-key"] as string | undefined;

  if (apiKey && provided !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
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

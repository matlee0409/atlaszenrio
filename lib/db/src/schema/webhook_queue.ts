import { pgTable, text, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const webhookStatusEnum = pgEnum("webhook_status", [
  "pending",
  "processing",
  "replied",
  "failed",
]);

export const webhookQueueTable = pgTable("webhook_queue", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("zernio"),
  payload: text("payload").notNull(),
  signature: text("signature"),
  status: webhookStatusEnum("status").notNull().default("pending"),
  reply: text("reply"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
});

export const insertWebhookSchema = createInsertSchema(webhookQueueTable).omit({
  id: true,
  createdAt: true,
  processedAt: true,
});

export type InsertWebhook = z.infer<typeof insertWebhookSchema>;
export type WebhookItem = typeof webhookQueueTable.$inferSelect;

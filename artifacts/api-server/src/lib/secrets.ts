import crypto from "crypto";
import { db } from "../db/index.js";
import { serverConfigTable } from "../db/schema/server_config.js";
import { eq } from "drizzle-orm";

let _signingSecret: string | null = null;

export async function getOrCreateSigningSecret(): Promise<string> {
  if (_signingSecret) return _signingSecret;

  if (process.env.ZERNIO_WEBHOOK_SECRET) {
    _signingSecret = process.env.ZERNIO_WEBHOOK_SECRET;
    return _signingSecret;
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS server_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const [row] = await db
    .select()
    .from(serverConfigTable)
    .where(eq(serverConfigTable.key, "zernio_webhook_secret"))
    .limit(1);

  if (row) {
    _signingSecret = row.value;
    return _signingSecret;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  await db.insert(serverConfigTable).values({
    key: "zernio_webhook_secret",
    value: generated,
  });
  _signingSecret = generated;
  return _signingSecret;
}

export function getSigningSecret(): string | null {
  return _signingSecret;
}

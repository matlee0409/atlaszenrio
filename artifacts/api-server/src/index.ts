import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const host =
    process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${port}`;

  const webhookUrl = `${host}/api/webhooks/zernio`;
  const signingSecret = process.env.ZERNIO_WEBHOOK_SECRET;
  const pollApiKey = process.env.POLL_API_KEY;
  const agentId = process.env.ATLAS_AGENT_ID;

  const missing: string[] = [];
  if (!signingSecret) missing.push("ZERNIO_WEBHOOK_SECRET");
  if (!pollApiKey) missing.push("POLL_API_KEY");
  if (!agentId) missing.push("ATLAS_AGENT_ID");

  console.log(`
╔══════════════════════════════════════════════════════╗
║              Webhook Configuration                   ║
╠══════════════════════════════════════════════════════╣
║ Webhook URL    : ${webhookUrl.padEnd(34)}║
║ Signing Secret : ${(signingSecret ? "✓ set" : "✗ NOT SET — webhooks will be rejected").padEnd(34)}║
║ Events         : ${"message.received, comment.received".padEnd(34)}║
╠══════════════════════════════════════════════════════╣
║              Atlas Poll Configuration                ║
╠══════════════════════════════════════════════════════╣
║ Poll API Key   : ${(pollApiKey ? "✓ set" : "✗ NOT SET — poll endpoint locked out").padEnd(34)}║
║ Agent ID       : ${(agentId ? "✓ set" : "✗ NOT SET — poll endpoint locked out").padEnd(34)}║
╚══════════════════════════════════════════════════════╝
`);

  if (missing.length > 0) {
    console.warn(`⚠️  Missing environment variables on Railway: ${missing.join(", ")}`);
    console.warn("   Set them in Railway → Variables, then redeploy.");
    console.warn("   Generate values with: openssl rand -hex 32");
  }
});

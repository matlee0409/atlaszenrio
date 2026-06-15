import app from "./app.js";
import { logger } from "./lib/logger.js";
import { getOrCreateSigningSecret } from "./lib/secrets.js";

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

async function start() {
  const signingSecret = await getOrCreateSigningSecret();

  const secretSource = process.env.ZERNIO_WEBHOOK_SECRET
    ? "env var"
    : "auto-generated (stored in DB)";

  app.listen(port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    const host = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${port}`;

    const webhookUrl = `${host}/api/webhooks/zernio`;
    const pollApiKey = process.env.POLL_API_KEY;
    const agentId = process.env.ATLAS_AGENT_ID;

    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                    Webhook Configuration                             ║
╠══════════════════════════════════════════════════════════════════════╣
║ Webhook URL    : ${webhookUrl.padEnd(50)}║
║ Signing Secret : ${signingSecret.padEnd(50)}║
║ Secret source  : ${secretSource.padEnd(50)}║
║ Events         : ${"message.received, comment.received".padEnd(50)}║
╠══════════════════════════════════════════════════════════════════════╣
║                    Atlas Poll Configuration                          ║
╠══════════════════════════════════════════════════════════════════════╣
║ Poll API Key   : ${(pollApiKey ? "✓ set" : "✗ NOT SET — set POLL_API_KEY on Railway").padEnd(50)}║
║ Agent ID       : ${(agentId ? "✓ set" : "✗ NOT SET — set ATLAS_AGENT_ID on Railway").padEnd(50)}║
╚══════════════════════════════════════════════════════════════════════╝

  ➜ Copy the Signing Secret above into Zernio dashboard → Webhooks → Secret Key
`);
  });
}

start().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

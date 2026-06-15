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
  const signingSecret = process.env.ZERNIO_WEBHOOK_SECRET ?? "(not set)";
  const pollApiKey = process.env.POLL_API_KEY ?? "(not set)";
  const agentId = process.env.ATLAS_AGENT_ID ?? "(not set)";

  console.log(`
╔══════════════════════════════════════════════════════╗
║              Webhook Configuration                   ║
╠══════════════════════════════════════════════════════╣
║ Webhook URL    : ${webhookUrl.padEnd(34)}║
║ Signing Secret : ${signingSecret.padEnd(34)}║
║ Events         : ${"post.published, post.failed, post.partial".padEnd(34)}║
╠══════════════════════════════════════════════════════╣
║              Atlas Poll Configuration                ║
╠══════════════════════════════════════════════════════╣
║ Poll API Key   : ${pollApiKey.padEnd(34)}║
║ Agent ID       : ${agentId.padEnd(34)}║
╚══════════════════════════════════════════════════════╝
`);
});

import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/config/status", (_req, res) => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${process.env.PORT ?? 3000}`;

  res.json({
    webhookUrl: `${host}/api/webhooks/zernio`,
    pollUrl: `${host}/api/webhooks/poll`,
    env: {
      ZERNIO_WEBHOOK_SECRET: !!process.env.ZERNIO_WEBHOOK_SECRET,
      POLL_API_KEY: !!process.env.POLL_API_KEY,
      ATLAS_AGENT_ID: !!process.env.ATLAS_AGENT_ID,
    },
    events: ["message.received", "comment.received"],
  });
});

export default router;

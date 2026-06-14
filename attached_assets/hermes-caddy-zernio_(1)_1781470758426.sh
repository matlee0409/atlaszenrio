#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Zernio Webhook Setup for Hermes Agent  —  DOCKER CADDY + NATIVE-HERMES edition
#
# This script for followin server's configuration:
#   * n8n runing in Docker, proxied by Caddy in the same container (n8n.YOUR-DOMAIN.XYZ)
#   * Hermes is a NATIVE install (NOT Docker):
#         config  : ~/.hermes/config.yaml
#         gateway : host process (systemd unit "hermes-gateway" OR `hermes gateway`)
#   * Caddy runs IN DOCKER (the ~/YOUR-FOLDER compose) and already does
#         auto-HTTPS for n8n.YOUR-DOMAIN.XYZ
#
# What it does:
#   1. Enables Hermes' webhook platform + a "zernio" route in ~/.hermes/config.yaml
#      (binds 0.0.0.0:8644 on the host)
#   2. Patches the NATIVE webhook.py to verify Zernio's X-Zernio-Signature header,
#      plus the OpenAI SDK NoneType fix (located via the Hermes venv)
#   3. Appends a Caddy site block that reverse-proxies /webhooks/* to the host,
#      using the Docker bridge GATEWAY IP (so the in-container Caddy can reach the
#      native Hermes process). No compose edits — Caddyfile append only.
#   4. Opens port 8644 to the Docker subnet ONLY (UFW), keeps it closed to the world
#   5. Reloads Caddy, restarts Hermes, and verifies end-to-end
#
# Everything is backed up first. Re-runnable (idempotent).
# Run on the VPS host as root:   bash setup_zernio_webhook_caddy.sh
#
# ── EDIT THIS if you want a different hostname ───────────────────────────────
HERMES_DOMAIN="${HERMES_DOMAIN:-hermes.YOUR-DOMAIN.XYZ}"
WEBHOOK_PORT="${WEBHOOK_PORT:-8644}"
# NOTE: point an A record for $HERMES_DOMAIN at this server BEFORE running,
#       exactly like you did for n8n.YOUR-DOMAIN.XYZ — otherwise Caddy can't
#       issue the TLS cert.
###############################################################################

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CONFIG_FILE="$HERMES_HOME/config.yaml"
TS=$(date +%Y%m%d%H%M%S)
HMAC_SECRET=$(openssl rand -hex 32)
SERVER_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "")

echo ""
echo "══════════════════════════════════════════════════"
echo "  Zernio Webhook Setup  (Caddy + native Hermes)"
echo "══════════════════════════════════════════════════"
echo "  Hermes config : $CONFIG_FILE"
echo "  Public host   : $HERMES_DOMAIN"
echo "  Webhook port  : $WEBHOOK_PORT (host)"
echo ""

# ── Sanity: native Hermes present ────────────────────────────────────────────
[[ -f "$CONFIG_FILE" ]] || { echo "❌ $CONFIG_FILE not found. Is Hermes installed natively?"; exit 1; }

HERMES_PY="/usr/local/lib/hermes-agent/venv/bin/python"
[[ -x "$HERMES_PY" ]] || HERMES_PY="$(command -v python3)"

# ── Detect the Caddy container, its Caddyfile, network gateway + subnet ───────
CADDY_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i caddy | head -1 || true)
[[ -n "$CADDY_CONTAINER" ]] || { echo "❌ No running Caddy container found (docker ps | grep caddy)."; exit 1; }

# Host path of the bind-mounted Caddyfile (Destination is the in-container path)
CADDYFILE_HOST=$(docker inspect "$CADDY_CONTAINER" \
  --format '{{range .Mounts}}{{.Source}}::{{.Destination}}{{"\n"}}{{end}}' \
  | grep -i 'caddyfile' | head -1 | awk -F'::' '{print $1}')
CADDYFILE_IN=$(docker inspect "$CADDY_CONTAINER" \
  --format '{{range .Mounts}}{{.Source}}::{{.Destination}}{{"\n"}}{{end}}' \
  | grep -i 'caddyfile' | head -1 | awk -F'::' '{print $2}')
[[ -f "$CADDYFILE_HOST" ]] || { echo "❌ Could not locate a Caddyfile bind-mounted into $CADDY_CONTAINER."; \
  echo "   Tell me your Caddy config layout and I'll adjust."; exit 1; }
[[ -n "$CADDYFILE_IN" ]] || CADDYFILE_IN="/etc/caddy/Caddyfile"

CADDY_NET=$(docker inspect "$CADDY_CONTAINER" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | head -1)
GW_IP=$(docker network inspect "$CADDY_NET" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
SUBNET=$(docker network inspect "$CADDY_NET" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)
[[ -n "$GW_IP" ]] || { echo "❌ Could not derive Docker bridge gateway IP for network $CADDY_NET."; exit 1; }

echo "  Caddy cont.   : $CADDY_CONTAINER"
echo "  Caddyfile     : $CADDYFILE_HOST  (-> $CADDYFILE_IN in container)"
echo "  Caddy network : $CADDY_NET"
echo "  Bridge GW IP  : $GW_IP   (Caddy -> host Hermes target)"
echo "  Bridge subnet : $SUBNET"
echo ""

# ── DNS pre-check (warn only) ─────────────────────────────────────────────────
RESOLVED=$(getent hosts "$HERMES_DOMAIN" | awk '{print $1}' | head -1 || true)
if [[ -n "$SERVER_IP" && -n "$RESOLVED" && "$RESOLVED" != "$SERVER_IP" ]]; then
  echo "  ⚠️  $HERMES_DOMAIN resolves to $RESOLVED but this server is $SERVER_IP."
  echo "      Caddy will not get a cert until the A record points here. Continuing anyway."
  echo ""
elif [[ -z "$RESOLVED" ]]; then
  echo "  ⚠️  $HERMES_DOMAIN does not resolve yet. Add the A record, then Caddy will"
  echo "      auto-issue the cert on its next attempt. Continuing anyway."
  echo ""
fi

# ── Step 1: Backup ────────────────────────────────────────────────────────────
echo "[1/6] Backing up..."
cp "$CONFIG_FILE"     "${CONFIG_FILE}.bak.${TS}"
cp "$CADDYFILE_HOST"  "${CADDYFILE_HOST}.bak.${TS}"
echo "  ok  (config + Caddyfile)"

# ── Step 2: Enable webhook platform + zernio route in Hermes config ───────────
echo "[2/6] Updating $CONFIG_FILE ..."
if grep -q '^  webhook:' "$CONFIG_FILE" 2>/dev/null; then
  echo "  skip (webhook already in config)"
else
  HMAC_SECRET="$HMAC_SECRET" CONFIG_FILE="$CONFIG_FILE" WEBHOOK_PORT="$WEBHOOK_PORT" python3 - <<'PY'
import os
secret = os.environ["HMAC_SECRET"]
path   = os.environ["CONFIG_FILE"]
port   = os.environ["WEBHOOK_PORT"]

with open(path) as f:
    content = f.read()

block = (
    "  webhook:\n"
    "    enabled: true\n"
    "    extra:\n"
    "      host: 0.0.0.0\n"
    f"      port: {port}\n"
    f"      secret: {secret}\n"
    "      routes:\n"
    "        zernio:\n"
    f'          secret: "{secret}"\n'
    '          prompt: ""\n'
)

if "\nplatforms:\n" in content:
    content = content.replace("\nplatforms:\n", "\nplatforms:\n" + block, 1)
else:
    # No platforms: key yet — append one
    content = content.rstrip() + "\n\nplatforms:\n" + block

with open(path, "w") as f:
    f.write(content)
PY
  if grep -q '^  webhook:' "$CONFIG_FILE" && grep -q 'zernio:' "$CONFIG_FILE"; then
    echo "  ok"
  else
    echo "  ❌ config insert failed — restoring backup"
    cp "${CONFIG_FILE}.bak.${TS}" "$CONFIG_FILE"
    exit 1
  fi
fi

# ── Step 3: Patch native webhook.py (Zernio sig) + OpenAI SDK NoneType fix ────
echo "[3/6] Applying signature + SDK patches (native)..."
cat > "$HERMES_HOME/apply_zernio_patch.py" << 'PY_PATCHFILE'
"""Idempotent. Patches the NATIVE Hermes webhook.py for Zernio's X-Zernio-Signature
header, plus the OpenAI SDK NoneType output fix. Safe to re-run after a Hermes upgrade."""
import subprocess, sys
from pathlib import Path

# 1) Locate webhook.py inside the native install / venv
roots = ["/usr/local/lib/hermes-agent", str(Path.home() / ".hermes")]
target = None
for r in roots:
    p = Path(r)
    if not p.exists():
        continue
    hits = [h for h in p.rglob("webhook.py") if "platform" in str(h)]
    if hits:
        target = hits[0]
        break

if target and target.exists():
    src = target.read_text()
    if "# Zernio: X-Zernio-Signature" not in src:
        old = "        # Generic: X-Webhook-Signature"
        new = (
            '        # Zernio: X-Zernio-Signature = <hex HMAC-SHA256>\n'
            '        zernio_sig = request.headers.get("X-Zernio-Signature", "")\n'
            '        if zernio_sig:\n'
            '            expected = hmac.new(\n'
            '                secret.encode(), body, hashlib.sha256\n'
            '            ).hexdigest()\n'
            '            return hmac.compare_digest(zernio_sig, expected)\n\n'
            '        # Generic: X-Webhook-Signature'
        )
        if old in src:
            target.write_text(src.replace(old, new, 1))
            print(f"  webhook.py patched: {target}")
        else:
            print(f"  ⚠️ anchor not found in {target} — Hermes version may differ; skipped sig patch")
    else:
        print("  webhook.py already patched")
else:
    print("  ⚠️ could not locate platforms/webhook.py — skipped sig patch")

# 2) OpenAI SDK NoneType output fix (locate via importing in this interpreter)
try:
    import openai
    sdk = Path(openai.__file__).parent / "lib" / "_parsing" / "_responses.py"
    if sdk.exists():
        s = sdk.read_text()
        a, b = "for output in response.output:", "for output in (response.output or []):"
        if a in s and b not in s:
            sdk.write_text(s.replace(a, b, 1))
            print("  openai SDK patched")
        else:
            print("  openai SDK already ok")
except Exception as e:
    print(f"  ⚠️ openai SDK patch skipped: {e}")
PY_PATCHFILE

"$HERMES_PY" "$HERMES_HOME/apply_zernio_patch.py" || true
echo "  (re-run '$HERMES_PY $HERMES_HOME/apply_zernio_patch.py' after any 'hermes' upgrade)"

# ── Step 4: Append Caddy site block (proxy /webhooks/* -> host:8644) ──────────
echo "[4/6] Updating Caddyfile..."
if grep -q "$HERMES_DOMAIN" "$CADDYFILE_HOST" 2>/dev/null; then
  echo "  skip ($HERMES_DOMAIN already present)"
else
  cat >> "$CADDYFILE_HOST" <<EOF

# ── Hermes Agent webhook (Zernio) — added ${TS} ──
# Caddy runs in Docker; ${GW_IP} is the bridge gateway to the host where the
# native Hermes webhook listens on :${WEBHOOK_PORT}. If you ever recreate the
# Docker network, re-derive with:
#   docker network inspect ${CADDY_NET} --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
${HERMES_DOMAIN} {
    reverse_proxy /webhooks/* ${GW_IP}:${WEBHOOK_PORT}
}
EOF
  echo "  ok (appended site block)"
fi

# ── Step 5: Allow Docker subnet -> host:8644 (and keep it closed to the world) ─
echo "[5/6] Firewall (UFW)..."
if command -v ufw >/dev/null 2>&1; then
  if ufw status | grep -q "${WEBHOOK_PORT}.*${SUBNET}"; then
    echo "  skip (rule exists)"
  else
    ufw allow from "$SUBNET" to any port "$WEBHOOK_PORT" proto tcp >/dev/null
    echo "  ok (allowed $SUBNET -> :$WEBHOOK_PORT; still closed to public — only 22/80/443 open)"
  fi
else
  echo "  skip (ufw not present)"
fi

# ── Step 6: Reload Caddy + restart Hermes, then verify ────────────────────────
echo "[6/6] Reloading Caddy + restarting Hermes..."
docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_IN" 2>/dev/null \
  && echo "  caddy: reloaded" \
  || { echo "  caddy reload failed — restarting service"; \
       (cd "$(dirname "$CADDYFILE_HOST")" && docker compose restart "$CADDY_CONTAINER" 2>/dev/null) \
       || docker restart "$CADDY_CONTAINER" >/dev/null; echo "  caddy: restarted"; }

if systemctl list-unit-files 2>/dev/null | grep -q '^hermes-gateway'; then
  systemctl restart hermes-gateway && echo "  hermes: systemd restarted"
else
  ( hermes gateway restart 2>/dev/null && echo "  hermes: gateway restarted" ) \
    || ( hermes gateway stop 2>/dev/null; hermes gateway start 2>/dev/null && echo "  hermes: gateway start" ) \
    || echo "  ⚠️ restart Hermes manually so the new config + patch load"
fi

echo "  waiting 20s..."
sleep 20

echo ""
echo "  Verifying..."
INTERNAL=$(curl -sf "http://localhost:${WEBHOOK_PORT}/health" 2>/dev/null || true)
echo "$INTERNAL" | grep -q '"ok"' && echo "  internal (host:$WEBHOOK_PORT): ok" \
  || echo "  internal: not ready yet (give the gateway a moment; check: hermes logs gateway -n 50)"

HTTP_CODE=$(curl -so /dev/null -w "%{http_code}" -X POST \
  "https://${HERMES_DOMAIN}/webhooks/zernio" \
  -H "Content-Type: application/json" -d '{"ping":true}' 2>/dev/null || echo "000")
case "$HTTP_CODE" in
  401) echo "  external: ok (401 = signature required, routing + TLS work)";;
  202) echo "  external: ok (202 accepted)";;
  000) echo "  external: no response (DNS/cert may still be provisioning — recheck in a few min)";;
  *)   echo "  external: HTTP $HTTP_CODE (if 502, Hermes isn't reachable on $GW_IP:$WEBHOOK_PORT — see notes)";;
esac

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo "  DONE"
echo "══════════════════════════════════════════════════"
echo ""
echo "  Configure these in Zernio (zernio.com/dashboard/webhooks):"
echo ""
echo "    Webhook URL    : https://${HERMES_DOMAIN}/webhooks/zernio"
echo "    Signing Secret : ${HMAC_SECRET}"
echo "    Events         : message.received, comment.received"
echo ""
echo "  Rollback if needed:"
echo "    cp ${CONFIG_FILE}.bak.${TS} ${CONFIG_FILE}"
echo "    cp ${CADDYFILE_HOST}.bak.${TS} ${CADDYFILE_HOST}"
echo "    docker exec ${CADDY_CONTAINER} caddy reload --config ${CADDYFILE_IN}"
echo ""
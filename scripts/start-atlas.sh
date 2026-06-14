#!/usr/bin/env bash
# ─────────────────────────────────────────────
#  Atlas Poller — Start Script
#  Run this on your PC to connect Atlas to Railway.
#
#  First time setup:
#    cp atlas.env.example atlas.env
#    (edit atlas.env with your values)
#    chmod +x start-atlas.sh
#    ./start-atlas.sh
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/atlas.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo ""
  echo "  ❌  atlas.env not found."
  echo ""
  echo "  Setup:"
  echo "    cp scripts/atlas.env.example scripts/atlas.env"
  echo "    (edit atlas.env with your values)"
  echo "    ./scripts/start-atlas.sh"
  echo ""
  exit 1
fi

# Load env file
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# Validate required vars
MISSING=()
[[ -z "$RAILWAY_URL" ]]  && MISSING+=("RAILWAY_URL")
[[ -z "$POLL_API_KEY" ]] && MISSING+=("POLL_API_KEY")
[[ -z "$ATLAS_URL" ]]    && MISSING+=("ATLAS_URL")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "  ❌  Missing required values in atlas.env:"
  for var in "${MISSING[@]}"; do
    echo "       • $var"
  done
  echo ""
  echo "  Open atlas.env and fill in the missing values."
  echo ""
  exit 1
fi

echo ""
echo "  ✅  Config loaded from atlas.env"
echo ""

# Run the poller (works if Node + tsx are available globally, or via pnpm)
if command -v tsx &>/dev/null; then
  tsx "$SCRIPT_DIR/src/atlas-poller.ts"
elif command -v pnpm &>/dev/null; then
  pnpm --filter @workspace/scripts run atlas-poller
elif command -v npx &>/dev/null; then
  npx tsx "$SCRIPT_DIR/src/atlas-poller.ts"
else
  echo "  ❌  Could not find tsx, pnpm, or npx. Install Node.js from https://nodejs.org"
  exit 1
fi

#!/usr/bin/env bash
# Build and run OpenClaw from source with optional OpenAI custom model (openai-custom).
#
# Env (or .env / .env.openclaw-custom in repo root):
#   OPENAI_CUSTOM_BASE_URL   required to enable openai-custom (e.g. https://your-proxy/v1)
#   OPENAI_CUSTOM_API_KEY   optional; fallback: OPENAI_API_KEY
#   OPENAI_CUSTOM_MODEL     optional; default gpt-4o
#   GATEWAY_WATCH=1         default; use 0 to run gateway once with --verbose
#   GATEWAY_PORT=18789      used when GATEWAY_WATCH=0
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Load custom model env (do not override existing env)
if [[ -f "$REPO_ROOT/.env.openclaw-custom" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env.openclaw-custom"
  set +a
  echo "Loaded OPENAI_CUSTOM_* from .env.openclaw-custom"
elif [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env"
  set +a
  echo "Loaded env from .env"
fi

if [[ -n "${OPENAI_CUSTOM_BASE_URL:-}" ]]; then
  echo "OpenAI custom model enabled: baseUrl=$OPENAI_CUSTOM_BASE_URL model=${OPENAI_CUSTOM_MODEL:-gpt-4o}"
else
  echo "OpenAI custom model disabled (set OPENAI_CUSTOM_BASE_URL to enable)."
fi

# --- Stop any existing gateway (supervised or on port) so we can start clean
echo ""
echo ">>> Stopping existing gateway (if any)"
pnpm openclaw gateway stop 2>/dev/null || true

# --- Install and build
echo ""
echo ">>> pnpm install"
pnpm install

echo ""
echo ">>> pnpm ui:build"
pnpm ui:build

echo ""
echo ">>> pnpm build"
pnpm build

# --- Set default model to openai-custom when using custom endpoint (avoids openai-codex auth error)
if [[ -n "${OPENAI_CUSTOM_BASE_URL:-}" ]]; then
  OPENAI_CUSTOM_MODEL_ID="${OPENAI_CUSTOM_MODEL:-gpt-4o}"
  echo ""
  echo ">>> Setting default model to openai-custom/$OPENAI_CUSTOM_MODEL_ID"
  pnpm openclaw models set "openai-custom/$OPENAI_CUSTOM_MODEL_ID" 2>/dev/null || true
fi

# --- Run gateway (inherits OPENAI_CUSTOM_* from current shell)
echo ""
echo ">>> Starting gateway (Ctrl+C to stop)"
echo "    Use: openclaw agent --message \"Hello\" --thinking high"
echo ""

if [[ "${GATEWAY_WATCH:-1}" = "1" ]]; then
  exec pnpm gateway:watch
else
  exec pnpm openclaw gateway --port "${GATEWAY_PORT:-18789}" --verbose
fi

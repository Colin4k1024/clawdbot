#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Quick-Start Image Builder
#
# Usage:
#   ./scripts/quickstart-build.sh                    # Build locally
#   ./scripts/quickstart-build.sh --push             # Build + push to ACR
#   ./scripts/quickstart-build.sh --tag v1.0         # Custom tag
#   ./scripts/quickstart-build.sh --platform linux/amd64,linux/arm64  # Multi-arch
#
# Environment:
#   ACR_REGISTRY   - ACR endpoint (default: registry.cn-hangzhou.aliyuncs.com)
#   ACR_NAMESPACE  - ACR namespace (required for --push)
#   ACR_IMAGE      - Image name (default: openclaw)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
ACR_REGISTRY="${ACR_REGISTRY:-registry.cn-hangzhou.aliyuncs.com}"
ACR_IMAGE="${ACR_IMAGE:-openclaw}"
TAG="quickstart"
PUSH=false
PLATFORM=""
VERIFY=true

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) PUSH=true; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --no-verify) VERIFY=false; shift ;;
    --help|-h)
      echo "Usage: $0 [--push] [--tag TAG] [--platform PLATFORMS] [--no-verify]"
      echo ""
      echo "Options:"
      echo "  --push        Push to Alibaba ACR after build"
      echo "  --tag TAG     Image tag (default: quickstart)"
      echo "  --platform    Target platforms (e.g. linux/amd64,linux/arm64)"
      echo "  --no-verify   Skip startup time verification"
      echo ""
      echo "Environment:"
      echo "  ACR_REGISTRY   ACR endpoint (default: registry.cn-hangzhou.aliyuncs.com)"
      echo "  ACR_NAMESPACE  ACR namespace (required for --push)"
      echo "  ACR_IMAGE      Image name (default: openclaw)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

LOCAL_IMAGE="openclaw:${TAG}"

echo "==> Building quick-start image: ${LOCAL_IMAGE}"
echo "    Context: ${PROJECT_ROOT}"

cd "$PROJECT_ROOT"

# Build
if [[ -n "$PLATFORM" ]]; then
  if [[ "$PLATFORM" == *","* ]]; then
    # Multi-platform builds cannot use --load (local daemon is single-arch).
    # Must push directly to registry.
    if [[ "$PUSH" != "true" || -z "${ACR_NAMESPACE:-}" ]]; then
      echo "ERROR: Multi-platform builds require --push with ACR_NAMESPACE set."
      echo "  --load only supports single-platform builds."
      exit 1
    fi
    ACR_FULL="${ACR_REGISTRY}/${ACR_NAMESPACE}/${ACR_IMAGE}:${TAG}"
    echo "    Platform: ${PLATFORM} (multi-arch, pushing directly to ${ACR_FULL})"
    docker buildx build \
      -f Dockerfile.quickstart \
      --platform "$PLATFORM" \
      -t "$ACR_FULL" \
      --push \
      .
    VERIFY=false
    echo "    Multi-arch build pushed. Skipping local verify (no local image)."
  else
    echo "    Platform: ${PLATFORM} (using buildx)"
    docker buildx build \
      -f Dockerfile.quickstart \
      --platform "$PLATFORM" \
      -t "$LOCAL_IMAGE" \
      --load \
      .
  fi
else
  docker build \
    -f Dockerfile.quickstart \
    -t "$LOCAL_IMAGE" \
    .
fi

echo ""
echo "==> Build complete: ${LOCAL_IMAGE}"
docker images "$LOCAL_IMAGE" --format "    Size: {{.Size}}"

# Verify startup time
if [[ "$VERIFY" == "true" ]]; then
  echo ""
  echo "==> Verifying startup time..."

  CONTAINER_NAME="openclaw-quickstart-verify-$$"
  TOKEN="verify-$(openssl rand -hex 16)"

  # Clean up on exit
  cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  # Start container
  START_NS=$(date +%s%N 2>/dev/null || python3 -c "import time; print(int(time.time()*1e9))")

  docker run -d \
    --name "$CONTAINER_NAME" \
    -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
    -p 0:18789 \
    "$LOCAL_IMAGE" >/dev/null

  # Get mapped port
  PORT=$(docker port "$CONTAINER_NAME" 18789 | head -1 | cut -d: -f2)

  # Poll healthcheck
  READY=false
  for i in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
      READY=true
      break
    fi
    sleep 0.05
  done

  END_NS=$(date +%s%N 2>/dev/null || python3 -c "import time; print(int(time.time()*1e9))")

  if [[ "$READY" == "true" ]]; then
    ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
    if [[ $ELAPSED_MS -le 1000 ]]; then
      echo "    PASS: /healthz ready in ${ELAPSED_MS}ms (target: <1000ms)"
    else
      echo "    WARN: /healthz ready in ${ELAPSED_MS}ms (target: <1000ms)"
      echo "    Note: First run may be slower due to Docker overhead."
      echo "    The V8 compile cache is pre-warmed — subsequent starts will be faster."
    fi
  else
    echo "    FAIL: /healthz not ready within 2.5s"
    echo "    Container logs:"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -20
    cleanup
    trap - EXIT
    exit 1
  fi

  cleanup
  trap - EXIT
fi

# Push to ACR
if [[ "$PUSH" == "true" ]]; then
  if [[ -z "${ACR_NAMESPACE:-}" ]]; then
    echo ""
    echo "ERROR: ACR_NAMESPACE is required for --push"
    echo "  export ACR_NAMESPACE=your-namespace"
    echo "  $0 --push"
    exit 1
  fi

  ACR_FULL="${ACR_REGISTRY}/${ACR_NAMESPACE}/${ACR_IMAGE}:${TAG}"
  echo ""
  echo "==> Pushing to ACR: ${ACR_FULL}"

  docker tag "$LOCAL_IMAGE" "$ACR_FULL"
  docker push "$ACR_FULL"

  echo "    Push complete."
  echo ""
  echo "==> Quick start commands:"
  echo ""
  echo "  # Docker"
  echo "  docker run -d -p 18789:18789 \\"
  echo "    -e OPENCLAW_GATEWAY_TOKEN=\$(openssl rand -hex 32) \\"
  echo "    ${ACR_FULL}"
  echo ""
  echo "  # K8s (update image in deployment.yaml first)"
  echo "  kubectl apply -k k8s/quickstart/ -n openclaw"
else
  echo ""
  echo "==> Quick start commands:"
  echo ""
  echo "  # Docker"
  echo "  docker run -d -p 18789:18789 \\"
  echo "    -e OPENCLAW_GATEWAY_TOKEN=\$(openssl rand -hex 32) \\"
  echo "    ${LOCAL_IMAGE}"
  echo ""
  echo "  # Docker Compose"
  echo "  export OPENCLAW_GATEWAY_TOKEN=\$(openssl rand -hex 32)"
  echo "  docker compose -f docker-compose.quickstart.yml up -d"
  echo ""
  echo "  # K8s (kind)"
  echo "  kind load docker-image ${LOCAL_IMAGE}"
  echo "  kubectl create namespace openclaw 2>/dev/null || true"
  echo "  kubectl apply -k k8s/quickstart/ -n openclaw"
fi

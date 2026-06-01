#!/bin/bash
# ─── Aegis Auto-Start — kills port, builds, runs forever ─────
set -e

PORT="${PORT:-8080}"

echo "=== Aegis Startup ==="

# Kill anything on port
fuser -k "${PORT}/tcp" 2>/dev/null || true
pkill -f "dist/index.mjs" 2>/dev/null || true
sleep 1

# Build once
cd "$(dirname "$0")/artifacts/api-server"
pnpm run build

# Run with auto-restart on crash
while true; do
  echo "[$(date)] Starting server..."
  node --enable-source-maps ./dist/index.mjs || true
  echo "[$(date)] Server crashed — restarting in 3s..."
  sleep 3
done

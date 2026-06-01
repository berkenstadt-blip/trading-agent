#!/bin/bash
# ─── Aegis Auto-Start — kills port, cleans, builds, runs forever ─────
PORT="${PORT:-8080}"

echo "=== Aegis Startup ==="

# Kill anything on port
fuser -k "${PORT}/tcp" 2>/dev/null || true
pkill -f "dist/index.mjs" 2>/dev/null || true
sleep 1

# Go to server dir
cd "$(dirname "$0")/artifacts/api-server"

# Always clean dist — ensures new code runs, never stale binary
rm -rf dist

# Build fresh
pnpm run build

# Run with auto-restart on crash
while true; do
  echo "[$(date)] Starting server..."
  node --enable-source-maps ./dist/index.mjs || true
  echo "[$(date)] Server crashed — restarting in 3s..."
  sleep 3
  # On crash: re-pull latest code and rebuild before restarting
  cd "$(dirname "$0")/../../"
  git pull origin main 2>/dev/null || true
  cd artifacts/api-server
  rm -rf dist
  pnpm run build
done

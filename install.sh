#!/usr/bin/env bash
# One-shot installer for the non-Docker path. Usage: bash install.sh
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org and re-run."
  exit 1
fi
echo "Node $(node -v) detected. Installing dependencies…"
npm install --no-audit --no-fund
echo
echo "Done. Start the app with:"
echo "    npm start"
echo "Then open http://localhost:8000/ — the setup wizard runs on first launch."

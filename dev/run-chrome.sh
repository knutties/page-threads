#!/usr/bin/env bash
# Launch Chrome for Testing with the PageThreads extension pre-loaded.
# Usage: dev/run-chrome.sh [profile-name]   (default: user1; use user2 for the second-user test)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-user1}"
CHROME=$(ls -d "$HOME/.cache/pagethreads-browsers/chrome/"*/chrome-mac-arm64/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" | sort | tail -1)

exec "$CHROME" \
  --user-data-dir="$HOME/.cache/pagethreads-browsers/profile-$PROFILE" \
  --disable-extensions-except="$REPO_ROOT/dist" \
  --load-extension="$REPO_ROOT/dist" \
  --no-first-run \
  --no-default-browser-check \
  "https://127.0.0.1:9090"

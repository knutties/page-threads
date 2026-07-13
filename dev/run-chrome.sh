#!/usr/bin/env bash
# Launch Chrome for Testing with the PageThreads extension pre-loaded.
# Usage: dev/run-chrome.sh [profile-name] [extension-dir]
#   dev/run-chrome.sh          -> profile user1, extension dist/
#   dev/run-chrome.sh user2    -> second profile, same dist/ (sign in as another user)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-user1}"
EXT_DIR="$REPO_ROOT/${2:-dist}"
CHROME=$(ls -d "$HOME/.cache/pagethreads-browsers/chrome/"*/chrome-mac-arm64/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" | sort | tail -1)

exec "$CHROME" \
  --user-data-dir="$HOME/.cache/pagethreads-browsers/profile-$PROFILE" \
  --disable-extensions-except="$EXT_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://127.0.0.1:9090"

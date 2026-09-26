#!/usr/bin/env bash
# Compare the version a running Rekey API reports with what npm serves.
#
#   scripts/check-deployed-version.sh https://api.example.com [dist-tag]
#
# Publishing to npm and deploying the API are separate acts, so one can happen
# without the other. This reads GET /health/live (which reports `version` and
# `commit`) and `npm view @rekey.dev/node dist-tags`, prints both, and exits 1
# when the running version differs from the dist-tag (default `latest`).
#
# Needs curl, npm and node. Read-only: it changes nothing anywhere.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <api-base-url> [dist-tag]" >&2
  exit 2
fi

API="${1%/}"
TAG="${2:-latest}"
PKG="@rekey.dev/node"

HEALTH=$(curl -fsS --max-time 10 "$API/health/live") || {
  echo "could not reach $API/health/live" >&2
  exit 2
}
TAGS=$(npm view "$PKG" dist-tags --json --prefer-online) || {
  echo "npm view $PKG dist-tags failed" >&2
  exit 2
}

HEALTH="$HEALTH" TAGS="$TAGS" TAG="$TAG" API="$API" PKG="$PKG" node -e '
  const health = JSON.parse(process.env.HEALTH);
  const tags = JSON.parse(process.env.TAGS);
  const tag = process.env.TAG;
  const running = health.version ?? "(not reported: build predates the version field)";
  const published = tags[tag];
  console.log(`${process.env.API}  version ${running}  commit ${health.commit ?? "(not reported)"}`);
  console.log(`npm ${process.env.PKG}  ${Object.entries(tags).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if (published === undefined) {
    console.error(`npm has no "${tag}" dist-tag for ${process.env.PKG}`);
    process.exit(2);
  }
  if (running !== published) {
    console.error(`MISMATCH: the API runs ${running}, npm "${tag}" is ${published}`);
    process.exit(1);
  }
  console.log(`OK: the API runs the "${tag}" release`);
'

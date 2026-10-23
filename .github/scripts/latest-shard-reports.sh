#!/usr/bin/env bash
# Copies the newest attempt's report for each API test shard into one folder.
#
# Usage: latest-shard-reports.sh <downloaded-artifacts-dir> <reports-dir>
# Each artifact is a folder named api-blob-<shard>-<attempt>. A shard re-run
# with "Re-run failed jobs" has one folder per attempt; only the newest counts.
#
# Self-test: latest-shard-reports.sh --self-test
set -euo pipefail

pick() {
  local from=$1 to=$2 shard attempt
  mkdir -p "$to"
  # "<shard> <attempt>" per folder, numeric sort, then the last line per shard.
  for dir in "$from"/api-blob-*-*; do
    [ -d "$dir" ] || continue
    name=${dir##*/api-blob-}
    echo "${name%-*} ${name##*-}"
  done | sort -k1,1n -k2,2n | awk '{ newest[$1] = $2 } END { for (s in newest) print s, newest[s] }' |
    while read -r shard attempt; do
      echo "shard $shard: attempt $attempt"
      cp "$from/api-blob-$shard-$attempt"/* "$to"/
    done
}

if [ "${1:-}" = "--self-test" ]; then
  t=$(mktemp -d)
  trap 'rm -rf "$t"' EXIT
  mkdir -p "$t/in/api-blob-1-1" "$t/in/api-blob-2-1" "$t/in/api-blob-2-2" "$t/in/api-blob-2-10"
  echo pass > "$t/in/api-blob-1-1/blob-1-4.json"
  echo fail > "$t/in/api-blob-2-1/blob-2-4.json"
  echo fail > "$t/in/api-blob-2-2/blob-2-4.json"
  echo pass > "$t/in/api-blob-2-10/blob-2-4.json"
  pick "$t/in" "$t/out" >/dev/null
  [ "$(ls "$t/out" | wc -l | tr -d ' ')" = 2 ] || { echo "self-test: expected 2 reports"; exit 1; }
  [ "$(cat "$t/out/blob-2-4.json")" = pass ] || { echo "self-test: shard 2 did not take attempt 10"; exit 1; }
  echo "latest-shard-reports: self-test passed"
  exit 0
fi

pick "$1" "$2"

#!/usr/bin/env bash
# Copy the REAL run records the hosted API serves into deploy/aws/data/runs/ (gitignored), which the
# Dockerfile bakes into the image at /app/data/runs. Only hash-verifiable bundle files are copied —
# <runId>.json, index.json and timeline.jsonl per run — never spans, SQLite stores, the event
# journal or anything under runs/_*/. Sample/fixture bundles are skipped (the hosted chat only uses
# real runs, and fixture data is never mixed with live data).
# No AWS access needed; deploy.sh runs this before `docker build`.
set -euo pipefail
AWS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$AWS_DIR/../.." && pwd)"
SRC="${NOTARY_SOURCE_RUNS:-$REPO_ROOT/packages/core/runs}"
DEST="$AWS_DIR/data/runs"

rm -rf "$DEST"
mkdir -p "$DEST"
n=0
if [ -d "$SRC" ]; then
  for dir in "$SRC"/*/; do
    [ -d "$dir" ] || continue
    id="$(basename "$dir")"
    case "$id" in _*|demo*|fixture*) continue ;; esac
    [ -f "$dir/$id.json" ] || continue
    # Skip anything flagged sample (fixture/synthetic) — checked by parsing, not by name.
    if ! node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(b.sample===false?0:1)' "$dir/$id.json"; then
      continue
    fi
    mkdir -p "$DEST/$id"
    cp "$dir/$id.json" "$DEST/$id/"
    [ -f "$dir/index.json" ] && cp "$dir/index.json" "$DEST/$id/"
    [ -f "$dir/timeline.jsonl" ] && cp "$dir/timeline.jsonl" "$DEST/$id/"
    n=$((n + 1))
  done
fi
echo "notary-aws: staged $n real run(s) into deploy/aws/data/runs"

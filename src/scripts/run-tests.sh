#!/usr/bin/env bash
# run-tests.sh — single runner for all bun test variants.
#
# Sets up a timestamped log directory, captures all output, splits per-suite
# logs, generates a failure summary, and handles automatic rerun when the
# background branch-validation detects the environment went stale mid-run.
#
# Usage (via package.json scripts):
#   bash src/scripts/run-tests.sh                  # full suite, no timeout
#   bash src/scripts/run-tests.sh --timeout 5000   # fast mode

set -o pipefail

TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_DIR="logs/$TIMESTAMP"
mkdir -p "$LOG_DIR"

MASTER_LOG="$LOG_DIR/_master.log"
FAIL_LOG="$LOG_DIR/_failures.log"
MARKER="logs/.rerun-needed"

rm -f "$MARKER"

echo "==============================================="
echo " Starting E2E Integration Suite..."
echo " Log dir: $LOG_DIR"
echo "==============================================="

# E2E_LOG_DIR → orchestrator writes per-service logs + master log there.
# FORCE_COLOR=1 → bun emits ANSI codes even when stdout is piped.
# tee writes colored output to the terminal; the process substitution strips
# ANSI escape codes before writing to the log file (clean, searchable logs).
E2E_LOG_DIR="$LOG_DIR" FORCE_COLOR=1 bun test src/tests "$@" 2>&1 \
  | tee >(sed 's/\x1b\[[0-9;]*[mGKHFJA-Za-z]//g' > "$MASTER_LOG")
TEST_EXIT_CODE=${PIPESTATUS[0]}

# ── Auto-rerun on stale environment ──────────────────────────────────────────
# How your shell runner automatically manages the rerun loop in the background:
if [ -f "$MARKER" ]; then
  rm -f "$MARKER"
  echo "🔄 Remote branches updated or environment healed. Rerunning with fresh environment..."
  exec "$0" "$@"
fi

# ── Split master log into per-suite test logs ─────────────────────────────────
if [ -f "$MASTER_LOG" ]; then
  awk -v logdir="$LOG_DIR" '
    /__E2E_SUITE_START__:/ {
      split($0, a, "__E2E_SUITE_START__:");
      slug = a[2];
      gsub(/[[:space:]]/, "", slug);
      outfile = logdir "/test_" slug ".log";
      in_suite = 1;
      next
    }
    /__E2E_SUITE_END__:/ {
      in_suite = 0;
      outfile  = "";
      next
    }
    in_suite && outfile { print >> outfile }
  ' "$MASTER_LOG"
fi

echo ""
echo "==============================================="
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo " ✅ E2E Suite Passed!"
else
  echo " ❌ E2E Suite Failed!"
fi
echo "==============================================="

# ── Failure summary ───────────────────────────────────────────────────────────
if [ $TEST_EXIT_CODE -ne 0 ] && [ -f "$MASTER_LOG" ]; then
  {
    echo "=== E2E FAILURE SUMMARY ==="
    echo "Run: $TIMESTAMP"
    echo ""

    echo "Service logs to inspect:"
    for f in "$LOG_DIR"/*.log; do
      fname=$(basename "$f")
      [[ "$fname" != _* ]] && echo "  → $f"
    done
    echo ""

    echo "Per-suite test logs:"
    for f in "$LOG_DIR"/test_*.log; do
      [ -f "$f" ] && echo "  → $f"
    done
    echo ""

    echo "Test failures:"
    grep -hE '^\s*(error:|Expected:|Received:|at <anonymous>|\(fail\)|\^ |# Unhandled)' "$MASTER_LOG" \
    | sed -E \
        -e 's/^[[:space:]]*//' \
        -e 's/at <anonymous> \((.+)\)/→ \1/' \
    | awk '
      /^\(fail\)/ { print "\n✗ " substr($0, 7) }
      !/^\(fail\)/ { print "  " $0 }
    '
  } > "$FAIL_LOG"

  echo ""
  echo "┌──────────────────────────────────────────────────┐"
  echo "│  FAILURE SUMMARY — click file:line:col to jump   │"
  echo "└──────────────────────────────────────────────────┘"
  cat "$FAIL_LOG"
  echo ""
  echo "Full details → $FAIL_LOG"
fi

# Convenience symlink
(cd logs && rm -f latest && ln -s "$TIMESTAMP" latest)

exit $TEST_EXIT_CODE

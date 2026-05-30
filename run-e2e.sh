#!/bin/bash
set -o pipefail

TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_DIR="logs/$TIMESTAMP"
mkdir -p "$LOG_DIR"

MASTER_LOG="$LOG_DIR/_master.log"
FAIL_LOG="$LOG_DIR/_failures.log"

echo "==============================================="
echo " Starting E2E Integration Suite..."
echo " Log dir: $LOG_DIR"
echo "==============================================="

# Run full suite.
# E2E_LOG_DIR → orchestrator writes per-service logs + master log there.
# tee captures bun:test stdout/stderr into _master.log too.
E2E_LOG_DIR="$LOG_DIR" bun test --timeout 600000 2>&1 | tee "$MASTER_LOG"
TEST_EXIT_CODE=${PIPESTATUS[0]}

# ── Split master log into per-suite test logs ─────────────────────────────────
# e2e.spec.ts emits __E2E_SUITE_START__:<slug> / __E2E_SUITE_END__:<slug> markers.
# Lines between markers go into LOG_DIR/test_<slug>.log.
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
      if [[ "$fname" != _* ]]; then
        echo "  → $f"
      fi
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

# Convenience symlink: logs/latest → current run folder
(cd logs && rm -f latest && ln -s "$TIMESTAMP" latest)

exit $TEST_EXIT_CODE

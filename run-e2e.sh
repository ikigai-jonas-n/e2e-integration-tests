#!/bin/bash
set -o pipefail

mkdir -p logs

TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_FILE="logs/e2e-run-$TIMESTAMP.log"

echo "==============================================="
echo " Starting E2E Integration Suite..."
echo " Log file: $LOG_FILE"
echo "==============================================="

# Pass LOG_FILE to the orchestrator so it can append service logs directly to it.
# This keeps service stdout/stderr in the log even when verbose=false (terminal-silent).
E2E_LOG_FILE="$LOG_FILE" bun test --timeout 600000 2>&1 | tee "$LOG_FILE"
TEST_EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "==============================================="
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo " ✅ E2E Suite Passed!"
else
  echo " ❌ E2E Suite Failed!"
fi
echo "==============================================="

# ── Failure summary ───────────────────────────────────────────────────────────
# Reprint all test errors at the end so they're easy to find and navigate.
# Lines from services ([billing], [game], etc.) are excluded — only bun:test
# output is shown: expect assertion, Expected/Received values, file:line:col.
# In VS Code's terminal the "path/to/file.ts:line:col" links are clickable.
# ─────────────────────────────────────────────────────────────────────────────
if [ $TEST_EXIT_CODE -ne 0 ] && [ -f "$LOG_FILE" ]; then
  FAIL_BLOCK=$(
    grep -hE '^\s*(error:|Expected:|Received:|at <anonymous>|\(fail\)|\^ |# Unhandled)' "$LOG_FILE" \
    | sed -E \
        -e 's/^[[:space:]]*//' \
        -e 's/at <anonymous> \((.+)\)/→ \1/' \
    | awk '
      /^\(fail\)/ { print "\n✗ " substr($0, 7) }
      !/^\(fail\)/ { print "  " $0 }
    '
  )

  if [ -n "$FAIL_BLOCK" ]; then
    echo ""
    echo "┌──────────────────────────────────────────────────┐"
    echo "│  FAILURE SUMMARY — click file:line:col to jump   │"
    echo "└──────────────────────────────────────────────────┘"
    echo "$FAIL_BLOCK"
    echo ""
  fi
fi

exit $TEST_EXIT_CODE

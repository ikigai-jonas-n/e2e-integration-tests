#!/bin/bash
set -o pipefail

# Ensure logs directory exists
mkdir -p logs

# Generate timestamp
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_FILE="logs/e2e-run-$TIMESTAMP.log"

{
  echo "==============================================="
  echo " Starting E2E Integration Suite..."
  echo " Log file: $LOG_FILE"
  echo "==============================================="

  # Run the test suite
  bun test --timeout 600000
  TEST_EXIT_CODE=$?

  echo "==============================================="
  if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "✅ E2E Suite Passed!"
  else
    echo "❌ E2E Suite Failed!"
  fi
  echo "==============================================="

  exit $TEST_EXIT_CODE
} 2>&1 | tee "$LOG_FILE"

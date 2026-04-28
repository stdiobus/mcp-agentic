#!/bin/bash
#
# @license
# Copyright 2026-present Raman Marozau, raman@stdiobus.com
# SPDX-License-Identifier: Apache-2.0
#

#
# Run all MCP Agentic E2E tests sequentially.
# Each test is a self-contained TypeScript script that exercises the full pipeline:
#   MCP Client → InMemoryTransport → McpAgenticServer → InProcessExecutor → AgentHandler
#
# Uses tsx to run TypeScript directly — no compilation step needed.
#
# Usage: bash test/e2e/run-all.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TESTS_RUN=0
TESTS_FAILED=0
FAILED_TESTS=""

RUNNER="$PROJECT_DIR/node_modules/.bin/tsx"
if [ ! -x "$RUNNER" ]; then
  echo "Error: tsx not found at $RUNNER"
  echo "Run: cd mcp-agentic && npm install"
  exit 1
fi

echo "============================================"
echo "  MCP Agentic E2E Test Suite"
echo "============================================"
echo ""

for test_file in \
  "$SCRIPT_DIR/mcp-agentic-e2e.ts" \
  "$SCRIPT_DIR/mcp-agentic-stdio-e2e.ts" \
  "$SCRIPT_DIR/mcp-agentic-pack-e2e.ts" \
  "$SCRIPT_DIR/publish-blockers-e2e.ts"
do
  test_name="$(basename "$test_file")"

  if [ ! -f "$test_file" ]; then
    echo "────────────────────────────────────────────"
    echo "Skipping: $test_name (file not found)"
    echo "────────────────────────────────────────────"
    echo ""
    continue
  fi

  echo "────────────────────────────────────────────"
  echo "Running: $test_name"
  echo "────────────────────────────────────────────"

  TESTS_RUN=$((TESTS_RUN + 1))

  if "$RUNNER" "$test_file"; then
    echo "  → PASSED"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    FAILED_TESTS="$FAILED_TESTS  - $test_name\n"
    echo "  → FAILED"
  fi

  echo ""
done

echo "============================================"
echo "  E2E Suite Summary"
echo "============================================"
echo "  Tests run:    $TESTS_RUN"
echo "  Tests passed: $((TESTS_RUN - TESTS_FAILED))"
echo "  Tests failed: $TESTS_FAILED"

if [ $TESTS_FAILED -gt 0 ]; then
  echo ""
  echo "  Failed tests:"
  echo -e "$FAILED_TESTS"
  echo "============================================"
  exit 1
fi

echo "============================================"
exit 0

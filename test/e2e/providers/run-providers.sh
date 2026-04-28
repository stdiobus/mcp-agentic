#!/bin/bash
#
# @license
# Copyright 2026-present Raman Marozau, raman@stdiobus.com
# SPDX-License-Identifier: Apache-2.0
#

#
# Run live provider E2E tests sequentially.
# Each test exercises real AI provider APIs through the full MCP Agentic pipeline.
#
# Tests are automatically SKIPPED when the corresponding API key is not set.
# This script is NOT run in CI by default — only locally with valid API keys.
#
# Required environment variables (set any/all):
#   OPENAI_API_KEY       — for OpenAI tests
#   ANTHROPIC_API_KEY    — for Anthropic tests
#   GOOGLE_AI_API_KEY    — for Google Gemini tests
#
# Usage: bash test/e2e/providers/run-providers.sh
#        npm run test:e2e:providers
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TESTS_RUN=0
TESTS_FAILED=0
TESTS_SKIPPED=0
FAILED_TESTS=""

RUNNER="$PROJECT_DIR/node_modules/.bin/tsx"
if [ ! -x "$RUNNER" ]; then
  echo "Error: tsx not found at $RUNNER"
  echo "Run: npm install"
  exit 1
fi

echo "============================================"
echo "  MCP Agentic — Live Provider E2E Tests"
echo "============================================"
echo ""
echo "  API keys detected:"
[ -n "$OPENAI_API_KEY" ]    && echo "    ✓ OPENAI_API_KEY" || echo "    ✗ OPENAI_API_KEY (not set)"
[ -n "$ANTHROPIC_API_KEY" ] && echo "    ✓ ANTHROPIC_API_KEY" || echo "    ✗ ANTHROPIC_API_KEY (not set)"
[ -n "$GOOGLE_AI_API_KEY" ] && echo "    ✓ GOOGLE_AI_API_KEY" || echo "    ✗ GOOGLE_AI_API_KEY (not set)"
echo ""

for test_file in \
  "$SCRIPT_DIR/openai-live.e2e.ts" \
  "$SCRIPT_DIR/anthropic-live.e2e.ts" \
  "$SCRIPT_DIR/gemini-live.e2e.ts" \
  "$SCRIPT_DIR/multi-provider-live.e2e.ts" \
  "$SCRIPT_DIR/provider-errors-live.e2e.ts"
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

  # Determine timeout command (gtimeout on macOS via coreutils, timeout on Linux)
  TIMEOUT_CMD=""
  if command -v gtimeout &>/dev/null; then
    TIMEOUT_CMD="gtimeout 60"
  elif command -v timeout &>/dev/null; then
    TIMEOUT_CMD="timeout 60"
  fi

  if $TIMEOUT_CMD "$RUNNER" "$test_file"; then
    echo "  → PASSED (or skipped)"
  else
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 0 ]; then
      TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
    else
      TESTS_FAILED=$((TESTS_FAILED + 1))
      FAILED_TESTS="$FAILED_TESTS  - $test_name\n"
      echo "  → FAILED (exit code: $EXIT_CODE)"
    fi
  fi

  echo ""
done

echo "============================================"
echo "  Live Provider E2E Suite Summary"
echo "============================================"
echo "  Tests run:    $TESTS_RUN"
echo "  Tests passed: $((TESTS_RUN - TESTS_FAILED - TESTS_SKIPPED))"
echo "  Tests skipped: $TESTS_SKIPPED"
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

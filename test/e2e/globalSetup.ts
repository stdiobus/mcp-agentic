/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E global setup: build the project before running e2e tests.
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function globalSetup(): void {
  const projectRoot = resolve(__dirname, '..', '..');

  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch (error) {
    const err = error as { stderr?: Buffer };
    const stderr = err.stderr?.toString() ?? '';
    throw new Error(`E2E globalSetup: build failed.\n${stderr}`);
  }
}

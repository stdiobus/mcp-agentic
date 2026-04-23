/**
 * Jest configuration for e2e tests.
 *
 * Runs with maxWorkers=1 for process stability.
 * Higher timeout for real stdio transport tests.
 * globalSetup builds the project before tests run.
 */

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.m?tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  globalSetup: '<rootDir>/test/e2e/globalSetup.ts',
  testMatch: ['**/test/e2e/**/*.e2e.test.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
  clearMocks: true,
};

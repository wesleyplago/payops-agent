import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // The integration/chaos suites share one Postgres database and truncate it
    // between files. Running files serially keeps the proof deterministic.
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['default'],
    // Ledger sweep after every test file: SUM(debit) == SUM(credit), 0 orphan outbox.
    setupFiles: ['tests/setup/ledger-sweep.ts'],
  },
});

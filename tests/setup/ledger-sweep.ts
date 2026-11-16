/**
 * Mandatory end-of-suite ledger sweep.
 *
 * Registered via `setupFiles`, so this root-level afterAll runs after every
 * test file (after the file's own hooks). Every DB-backed file truncates the
 * test database on start, so sweeping at the end of each file covers every
 * transaction the suite ever wrote. A violation fails the file that left it.
 */
import { afterAll } from 'vitest';
import { TEST_DATABASE_URL } from '../../src/config';
import { createDb } from '../../src/db/client';
import { assertSweepClean } from '../../src/ledger/invariant';

afterAll(async () => {
  if (process.env.PAYOPS_SKIP_SWEEP === '1') return;
  const db = createDb({ url: TEST_DATABASE_URL, poolMax: 1, applicationName: 'payops-sweep' });
  try {
    const hasLedger = await db.schema.hasTable('transactions');
    if (!hasLedger) return; // unit-only run before migrations: nothing to sweep
    await assertSweepClean(db);
  } finally {
    await db.destroy();
  }
});

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, type Harness } from '../helpers/harness';
import { runChaos } from '../../src/chaos/runner';
import { assertLedgerInvariant } from '../../src/ledger/invariant';

describe('reduced chaos suite (CI: 100 executions)', () => {
  let db: Knex;
  let h: Harness;

  beforeAll(async () => {
    db = await setupTestDb();
    h = createHarness(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('has zero duplicates, zero ledger violations and zero orphan outbox', async () => {
    const report = await runChaos(h, {
      runs: 100,
      concurrency: 10,
      timeoutMs: 2000,
      seed: 20261023,
    });
    const out = path.resolve('reports/chaos-report-ci.json');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

    expect(report.summary.executions).toBe(100);
    expect(report.summary.duplicate_charges).toBe(0);
    expect(report.summary.duplicate_charge_rate).toBe(0);
    expect(report.summary.ledger_invariant_violations).toBe(0);
    expect(report.summary.orphan_outbox).toBe(0);
    expect(report.summary.unrecovered_failures).toBe(0);
    await assertLedgerInvariant(db);
  });
});

/**
 * Standalone ledger sweep: checks SUM(debit) == SUM(credit) for every
 * transaction, plus orphan / mismatched / unpublished outbox rows.
 *
 *   pnpm run report:ledger                     # sweeps DATABASE_URL
 *   pnpm run report:ledger -- --test           # sweeps TEST_DATABASE_URL
 *   pnpm run report:ledger -- --out reports/ledger-sweep.json
 *
 * Exit code 1 when any violation or orphan outbox row is found.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_DATABASE_URL } from '../src/config';
import { createDb } from '../src/db/client';
import { sweepLedger } from '../src/ledger/invariant';

const useTest = process.argv.includes('--test');
const url = useTest
  ? TEST_DATABASE_URL
  : (process.env.DATABASE_URL ?? 'postgres://payops:payops@localhost:5432/payops');
const outIdx = process.argv.indexOf('--out');

const db = createDb({ url, poolMax: 2, applicationName: 'payops-ledger-sweep' });
try {
  const sweep = await sweepLedger(db);
  const output = JSON.stringify({ database: useTest ? 'test' : 'main', ...sweep }, null, 2);
  if (outIdx !== -1) {
    const out = path.resolve(process.argv[outIdx + 1]!);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, output + '\n');
  }
  // eslint-disable-next-line no-console
  console.log(output);
  if (sweep.violations.length > 0 || sweep.orphan_outbox > 0 || sweep.outbox_payload_mismatch > 0) {
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}

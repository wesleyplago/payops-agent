import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupTestDb, createHarness } from '../tests/helpers/harness';
import { runChaos } from '../src/chaos/runner';

function arg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = Number(process.argv[idx + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name}`);
  return value;
}

const runs = arg('runs', 1000);
const concurrency = arg('concurrency', 20);
const timeoutMs = arg('timeout-ms', 2000);
const seed = arg('seed', 20261023);
const outPath = path.resolve(
  process.argv.indexOf('--out') !== -1
    ? process.argv[process.argv.indexOf('--out') + 1]!
    : 'reports/chaos-report.json',
);

const db = await setupTestDb();
const harness = createHarness(db);
const started = Date.now();
try {
  const report = await runChaos(harness, { runs, concurrency, timeoutMs, seed });
  report.config = { ...report.config, wall_clock_ms: Date.now() - started };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        report: outPath,
        wall_clock_ms: Date.now() - started,
        summary: report.summary,
        by_scenario: report.by_scenario,
      },
      null,
      2,
    ),
  );
  if (
    report.summary.duplicate_charges !== 0 ||
    report.summary.ledger_invariant_violations !== 0 ||
    report.summary.orphan_outbox !== 0 ||
    report.summary.unrecovered_failures !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}

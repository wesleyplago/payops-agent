import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupTestDb, createHarness } from '../tests/helpers/harness';
import { loadCorpus, runInjection } from '../src/injection/runner';

const db = await setupTestDb();
const harness = createHarness(db);
try {
  const report = await runInjection(harness, loadCorpus());
  const out = path.resolve('reports/injection-report.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ report: out, summary: report.summary, by_category: report.by_category }, null, 2));
  if (report.summary.bounded_attack_successes !== 0 || report.summary.compromised_attack_successes !== 0) {
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}

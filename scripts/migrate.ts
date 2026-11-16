import path from 'node:path';
import { loadConfig } from '../src/config';
import { createDb, runMigrations } from '../src/db/client';
import { seedInvoices } from '../src/db/seed';

const config = loadConfig();
const db = createDb({ url: config.databaseUrl });
try {
  await runMigrations(db, path.resolve('migrations'));
  await seedInvoices(db);
  // eslint-disable-next-line no-console
  console.log('migrations applied and invoices seeded');
} finally {
  await db.destroy();
}

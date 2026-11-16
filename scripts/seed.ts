import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { seedInvoices } from '../src/db/seed';

const config = loadConfig();
const db = createDb({ url: config.databaseUrl });
try {
  await seedInvoices(db);
  // eslint-disable-next-line no-console
  console.log('invoices seeded');
} finally {
  await db.destroy();
}

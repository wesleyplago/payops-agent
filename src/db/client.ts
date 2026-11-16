import knex, { type Knex } from 'knex';
import pg from 'pg';

// int8 defaults to string in node-postgres. Ledger amounts are safe integers.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export function createDb(options: {
  url: string;
  poolMax?: number;
  applicationName?: string;
}): Knex {
  return knex({
    client: 'pg',
    connection: {
      connectionString: options.url,
      application_name: options.applicationName ?? 'payops-agent',
    },
    pool: { min: 0, max: options.poolMax ?? 20 },
    acquireConnectionTimeout: 10_000,
  });
}

export async function runMigrations(
  db: Knex,
  directory = 'migrations',
): Promise<void> {
  await db.migrate.latest({
    directory,
    extension: 'ts',
    loadExtensions: ['.ts'],
  });
}

export async function truncateAll(db: Knex): Promise<void> {
  await db.raw(`
    TRUNCATE TABLE
      webhook_deliveries,
      approval_tokens,
      approval_requests,
      outbox,
      entries,
      transactions,
      invoices
    RESTART IDENTITY CASCADE
  `);
}

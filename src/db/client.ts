import knex, { type Knex } from 'knex';
import pg from 'pg';
import { staticMigrationSource } from './migrations';

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

/**
 * Applies pending migrations from the static source (see ./migrations.ts).
 * The second argument is kept for call-site compatibility and ignored.
 */
export async function runMigrations(db: Knex, _directory?: string): Promise<void> {
  await db.migrate.latest({ migrationSource: staticMigrationSource });
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

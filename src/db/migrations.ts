import type { Knex } from 'knex';
import * as m001 from '../../migrations/001_init';

/**
 * Static migration source.
 *
 * Knex's default directory loader uses Node's native `import()` on the
 * migration files. That works for `.ts` only when Node itself can strip types
 * (Node >= 22.18/23.6) or a loader like tsx is active. Under Vitest on Node 20
 * — exactly the CI image — it failed with `Unknown file extension ".ts"`, but
 * only on a fresh database, so it never showed up on an already-migrated dev
 * box. Importing statically lets whatever compiles this file (tsx, Vitest, tsc)
 * compile the migrations too.
 *
 * Names keep the original file names so databases migrated by the old
 * directory loader see no pending migrations.
 */
const migrations: Record<string, Knex.Migration> = {
  '001_init.ts': m001,
};

export const staticMigrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations).sort(),
  getMigrationName: (name) => name,
  getMigration: async (name) => {
    const migration = migrations[name];
    if (!migration) throw new Error(`unknown migration ${name}`);
    return migration;
  },
};

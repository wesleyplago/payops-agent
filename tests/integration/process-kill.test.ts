import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, requestToken, type Harness } from '../helpers/harness';
import { assertLedgerInvariant, assertSweepClean } from '../../src/ledger/invariant';

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`worker did not become ready: ${buffer}`)), 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
    });
    child.on('exit', (code, signal) => {
      if (!buffer.includes('"ready":true')) {
        clearTimeout(timer);
        reject(new Error(`worker exited early code=${code} signal=${signal}: ${buffer}`));
      }
    });
  });
}

describe('real SIGKILL during an open Postgres transaction', () => {
  let db: Knex;
  let h: Harness;

  beforeAll(async () => {
    db = await setupTestDb();
    h = createHarness(db);
  });

  afterAll(async () => {
    await assertSweepClean(db);
    await db.destroy();
  });

  it('rolls back partial entries and lets the same key complete exactly once', async () => {
    const key = randomUUID();
    const business = {
      amount_cents: 4_321,
      currency: 'BRL',
      customer_id: 'cus_crash',
      description: 'real process kill',
    };
    const { token } = await requestToken(h.tools, h.human, 'create_charge', business, key);

    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/crash-worker.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CRASH_KEY: key,
        CRASH_TOKEN: token,
        CRASH_AMOUNT: String(business.amount_cents),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForReady(child);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(0);
    expect(await db('entries').count('* as c').first()).toMatchObject({ c: 0 });
    expect(await db('outbox').count('* as c').first()).toMatchObject({ c: 0 });

    const tokenRow = await db('approval_tokens').where({ token_hash: (await import('node:crypto')).createHash('sha256').update(token).digest('hex') }).first();
    expect(tokenRow.used_at).toBeNull();

    const retry = await h.tools.execute('create_charge', {
      ...business,
      idempotency_key: key,
      approval_token: token,
    });
    expect(retry.ok).toBe(true);
    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(1);
    expect(await db('entries').count('* as c').first()).toMatchObject({ c: 2 });
    await assertLedgerInvariant(db);
  });
});

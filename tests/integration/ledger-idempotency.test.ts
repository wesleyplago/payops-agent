import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, runApproved, requestToken, type Harness } from '../helpers/harness';
import { assertLedgerInvariant, assertSweepClean } from '../../src/ledger/invariant';

describe('ledger idempotency', () => {
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

  it('posts a balanced double-entry charge and exactly one outbox event', async () => {
    const key = randomUUID();
    const business = {
      amount_cents: 12_500,
      currency: 'BRL',
      customer_id: 'cus_001',
      description: 'smoke charge',
    };
    const result = await runApproved(h.tools, h.human, 'create_charge', business, key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toMatchObject({
      amount_cents: 12_500,
      tool: 'create_charge',
      status: 'captured',
    });
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 1 });
    expect(await db('entries').count('* as c').first()).toMatchObject({ c: 2 });
    expect(await db('outbox').count('* as c').first()).toMatchObject({ c: 1 });
    await assertLedgerInvariant(db);
  });

  it('replays the original response for the same key without a new token', async () => {
    const key = randomUUID();
    const business = {
      amount_cents: 4_200,
      currency: 'BRL',
      customer_id: 'cus_002',
      description: 'replay me',
    };
    const first = await runApproved(h.tools, h.human, 'create_charge', business, key);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await h.tools.execute('create_charge', {
      ...business,
      idempotency_key: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.meta.replayed).toBe(true);
    expect(replay.data).toEqual(first.data);
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 2 });
  });

  it('rejects reuse of a key with different arguments', async () => {
    const key = randomUUID();
    const business = {
      amount_cents: 6_000,
      currency: 'BRL',
      customer_id: 'cus_003',
      description: 'original',
    };
    expect((await runApproved(h.tools, h.human, 'create_charge', business, key)).ok).toBe(true);

    const conflict = await h.tools.execute('create_charge', {
      ...business,
      amount_cents: 6_001,
      idempotency_key: key,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('serializes 20 concurrent retries into one transaction and one gateway capture', async () => {
    h.gateway.resetStats();
    const key = randomUUID();
    const business = {
      amount_cents: 9_900,
      currency: 'BRL',
      customer_id: 'cus_004',
      description: 'concurrent retries',
    };
    const { token } = await requestToken(h.tools, h.human, 'create_charge', business, key);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        h.tools.execute('create_charge', {
          ...business,
          idempotency_key: key,
          approval_token: token,
        }),
      ),
    );

    const failures = results.filter((r: import('../../src/tools/registry').ToolResult) => !r.ok);
    expect(failures).toEqual([]);
    const fresh = results.filter((r: import('../../src/tools/registry').ToolResult) => r.ok && r.meta.replayed === false);
    expect(fresh).toHaveLength(1);

    const txRows = await db('transactions').where({ idempotency_key: key });
    expect(txRows).toHaveLength(1);
    expect(await db('entries').where({ tx_id: txRows[0].id })).toHaveLength(2);
    expect(await db('outbox').where({ tx_id: txRows[0].id })).toHaveLength(1);
    expect(h.gateway.stats.calls).toBe(1);
    await assertLedgerInvariant(db);
  });
});

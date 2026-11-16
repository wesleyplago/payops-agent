import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, runApproved, requestToken, type Harness } from '../helpers/harness';
import { assertLedgerInvariant, assertSweepClean } from '../../src/ledger/invariant';
import { SimulatedCrash } from '../../src/domain/errors';
import { WebhookReceiver } from '../../src/services/webhook';

describe('atomicity under injected failure', () => {
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

  const charge = (amount = 5_000) => ({
    amount_cents: amount,
    currency: 'BRL',
    customer_id: 'cus_atomic',
    description: 'atomicity',
  });

  it('rolls back ledger, outbox and token when the gateway returns 500 before commit', async () => {
    const key = randomUUID();
    const args = charge();
    const { token } = await requestToken(h.tools, h.human, 'create_charge', args, key);
    const result = await h.tools.execute(
      'create_charge',
      { ...args, idempotency_key: key, approval_token: token },
      { faults: { gateway500BeforeCommit: true } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('GATEWAY_ERROR');
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 0 });
    expect(await db('entries').count('* as c').first()).toMatchObject({ c: 0 });
    expect(await db('outbox').count('* as c').first()).toMatchObject({ c: 0 });
    const tokenRow = await db('approval_tokens').where({ approval_id: (await db('approval_requests').where({ idempotency_key: key }).first()).id }).first();
    expect(tokenRow.used_at).toBeNull();
  });

  it('rolls back a partial double-entry when the process dies mid-transaction', async () => {
    const key = randomUUID();
    const args = charge();
    const { token } = await requestToken(h.tools, h.human, 'create_charge', args, key);
    await expect(
      h.tools.execute(
        'create_charge',
        { ...args, idempotency_key: key, approval_token: token },
        { faults: { crashBeforeCommit: true } },
      ),
    ).rejects.toBeInstanceOf(SimulatedCrash);

    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(0);
    expect(await db('entries').count('* as c').first()).toMatchObject({ c: 0 });
    expect(await db('outbox').count('* as c').first()).toMatchObject({ c: 0 });
  });

  it('replays instead of double-charging after a lost 500 response post-commit', async () => {
    const key = randomUUID();
    const args = charge(7_500);
    const { token } = await requestToken(h.tools, h.human, 'create_charge', args, key);
    const first = await h.tools.execute(
      'create_charge',
      { ...args, idempotency_key: key, approval_token: token },
      { faults: { gateway500AfterCommit: true } },
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe('GATEWAY_ERROR');

    const rows = await db('transactions').where({ idempotency_key: key });
    expect(rows).toHaveLength(1);

    const retry = await h.tools.execute('create_charge', {
      ...args,
      idempotency_key: key,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.meta.replayed).toBe(true);
    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(1);
    expect(await db('outbox').count('* as c').first()).toMatchObject({ c: 1 });
    await assertLedgerInvariant(db);
  });

  it('replays exactly once after a process death immediately after COMMIT', async () => {
    const key = randomUUID();
    const args = charge(8_100);
    const { token } = await requestToken(h.tools, h.human, 'create_charge', args, key);
    await expect(
      h.tools.execute(
        'create_charge',
        { ...args, idempotency_key: key, approval_token: token },
        { faults: { crashAfterCommit: true } },
      ),
    ).rejects.toBeInstanceOf(SimulatedCrash);

    const retry = await h.tools.execute('create_charge', {
      ...args,
      idempotency_key: key,
    });
    expect(retry.ok).toBe(true);
    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(1);
  });

  it('deduplicates a duplicate webhook delivery without touching the ledger', async () => {
    const key = randomUUID();
    const args = charge(1_100);
    const created = await runApproved(h.tools, h.human, 'create_charge', args, key);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const txId = (created.data as { transaction_id: string }).transaction_id;
    const outbox = await db('outbox').where({ tx_id: txId }).first();
    expect(outbox).toBeTruthy();

    const receiver = new WebhookReceiver(db);
    const first = await receiver.receive(outbox.payload);
    const second = await receiver.receive(outbox.payload);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await db('webhook_deliveries').count('* as c').first()).toMatchObject({ c: 1 });
    expect(await db('transactions').where({ id: txId })).toHaveLength(1);
    await assertLedgerInvariant(db);
  });
});

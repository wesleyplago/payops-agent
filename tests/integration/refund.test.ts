import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, runApproved, requestToken, type Harness } from '../helpers/harness';
import { assertLedgerInvariant, assertSweepClean } from '../../src/ledger/invariant';

async function createCharge(h: Harness, amount: number): Promise<{ id: string; key: string }> {
  const key = randomUUID();
  const result = await runApproved(
    h.tools,
    h.human,
    'create_charge',
    { amount_cents: amount, currency: 'BRL', customer_id: 'cus_refund', description: 'refund target' },
    key,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return { id: (result.data as { transaction_id: string }).transaction_id, key };
}

describe('refund bounds and concurrency', () => {
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

  it('refunds up to the capture and rejects the excess', async () => {
    const charge = await createCharge(h, 10_000);
    const first = await runApproved(
      h.tools,
      h.human,
      'refund',
      { charge_id: charge.id, amount_cents: 4_000, reason: 'partial' },
      randomUUID(),
    );
    expect(first.ok).toBe(true);

    const second = await runApproved(
      h.tools,
      h.human,
      'refund',
      { charge_id: charge.id, amount_cents: 7_000, reason: 'too much' },
      randomUUID(),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(['REFUND_EXCEEDS_CAPTURE', 'REFUND_DUPLICATE']).toContain(second.error.code);

    const refunds = await db('transactions').where({ related_tx_id: charge.id });
    expect(refunds).toHaveLength(1);
    const total = refunds.reduce((sum, row) => sum + Number(row.amount_cents), 0);
    expect(total).toBe(4_000);
    await assertLedgerInvariant(db);
  });

  it('replays a duplicate refund request instead of creating a second refund', async () => {
    const charge = await createCharge(h, 8_000);
    const key = randomUUID();
    const business = { charge_id: charge.id, amount_cents: 8_000, reason: 'full' };
    const first = await runApproved(h.tools, h.human, 'refund', business, key);
    expect(first.ok).toBe(true);

    const replay = await h.tools.execute('refund', {
      ...business,
      idempotency_key: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.meta.replayed).toBe(true);

    const attempts = await db('transactions').where({ related_tx_id: charge.id });
    expect(attempts).toHaveLength(1);
  });

  it('locks the capture so two concurrent partial refunds cannot jointly exceed it', async () => {
    const charge = await createCharge(h, 10_000);
    const keyA = randomUUID();
    const keyB = randomUUID();
    const businessA = { charge_id: charge.id, amount_cents: 6_000, reason: 'concurrent A' };
    const businessB = { charge_id: charge.id, amount_cents: 6_000, reason: 'concurrent B' };
    const [a, b] = await Promise.all([
      requestToken(h.tools, h.human, 'refund', businessA, keyA),
      requestToken(h.tools, h.human, 'refund', businessB, keyB),
    ]);

    const [ra, rb] = await Promise.all([
      h.tools.execute('refund', { ...businessA, idempotency_key: keyA, approval_token: a.token }),
      h.tools.execute('refund', { ...businessB, idempotency_key: keyB, approval_token: b.token }),
    ]);

    const successes = [ra, rb].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    const refunds = await db('transactions').where({ related_tx_id: charge.id });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount_cents)).toBe(6_000);
    await assertLedgerInvariant(db);
  });

  it('rejects a refund whose charge does not exist', async () => {
    const result = await runApproved(
      h.tools,
      h.human,
      'refund',
      { charge_id: randomUUID(), amount_cents: 100, reason: 'ghost' },
      randomUUID(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

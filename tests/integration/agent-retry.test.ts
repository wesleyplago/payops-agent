/**
 * Regression for INCIDENT-002: the agent (not the tool layer) retrying a
 * mutation after apparent success must replay the original response, without
 * a second approval request and without a second transaction.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, type Harness } from '../helpers/harness';

describe('agent-level retry after apparent success', () => {
  let db: Knex;
  let h: Harness;

  beforeAll(async () => {
    db = await setupTestDb();
    h = createHarness(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  const intentFor = (key: string, amount = 4_200) => ({
    tool: 'create_charge' as const,
    arguments: { amount_cents: amount, currency: 'BRL', customer_id: 'cus_retry', description: 'agent retry' },
    idempotency_key: key,
  });

  async function approvedRun(key: string) {
    const intent = intentFor(key);
    return h.human.storage.run(intent, () =>
      h.agent.execute({ message: 'charge', intent, documents: [] }),
    );
  }

  it('replays the original response with no second approval and one transaction', async () => {
    const key = randomUUID();
    const first = await approvedRun(key);
    expect(first.status).toBe('completed');
    const approvalsAfterFirst = await db('approval_requests').where({ idempotency_key: key });

    // Retry with the same key. No human is routed: a new approval would be denied.
    const retry = await h.agent.execute({ message: 'charge', intent: intentFor(key), documents: [] });

    expect(retry.status).toBe('completed');
    expect(retry.tool_calls).toEqual([
      expect.objectContaining({ tool: 'create_charge', ok: true, replayed: true }),
    ]);
    expect((retry.data as { transaction_id: string }).transaction_id).toBe(
      (first.data as { transaction_id: string }).transaction_id,
    );
    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(1);
    expect(await db('approval_requests').where({ idempotency_key: key })).toHaveLength(
      approvalsAfterFirst.length,
    );
  });

  it('still fails closed for a new key without approval', async () => {
    const key = randomUUID();
    const result = await h.agent.execute({ message: 'charge', intent: intentFor(key), documents: [] });
    expect(result.status).toBe('denied');
    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(0);
  });

  it('rejects the same key with different arguments and reports the real code', async () => {
    const key = randomUUID();
    await approvedRun(key);
    const conflict = await h.agent.execute({
      message: 'charge',
      intent: intentFor(key, 9_999),
      documents: [],
    });
    expect(conflict.status).toBe('failed');
    expect(conflict.answer).toContain('IDEMPOTENCY_CONFLICT');
    expect(await db('transactions').where({ idempotency_key: key })).toHaveLength(1);
  });

  it('names the real error code in the answer when the human denies', async () => {
    const result = await h.agent.execute({
      message: 'charge',
      intent: intentFor(randomUUID()),
      documents: [],
    });
    expect(result.answer).toContain('APPROVAL_DENIED');
    expect(result.answer).not.toContain('UNKNOWN');
  });
});

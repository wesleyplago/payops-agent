import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, requestToken, type Harness } from '../helpers/harness';
import { assertSweepClean } from '../../src/ledger/invariant';
import { ApprovalService, PendingHumanChannel } from '../../src/services/approval';

describe('human approval gate', () => {
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

  const business = (amount = 3_000) => ({
    amount_cents: amount,
    currency: 'BRL',
    customer_id: 'cus_approval',
    description: 'approval test',
  });

  it('fails closed without a token', async () => {
    const result = await h.tools.execute('create_charge', {
      ...business(),
      idempotency_key: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('APPROVAL_REQUIRED');
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 0 });
  });

  it('rejects a forged token', async () => {
    const result = await h.tools.execute('create_charge', {
      ...business(),
      idempotency_key: randomUUID(),
      approval_token: `apv_${'f'.repeat(43)}`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('APPROVAL_REQUIRED');
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 0 });
  });

  it('binds the token to the exact arguments and idempotency key', async () => {
    const key = randomUUID();
    const original = business(3_000);
    const { token } = await requestToken(h.tools, h.human, 'create_charge', original, key);

    const tampered = await h.tools.execute('create_charge', {
      ...original,
      amount_cents: 30_000,
      idempotency_key: key,
      approval_token: token,
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) return;
    expect(tampered.error.code).toBe('APPROVAL_DENIED');
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 0 });
  });

  it('denies when the simulated human sees a request that does not match the operator intent', async () => {
    const key = randomUUID();
    const requested = business(15_000);
    const result = await h.human.storage.run(
      { tool: 'create_charge', arguments: business(1_000), idempotency_key: key },
      () =>
        h.tools.execute('request_approval', {
          tool: 'create_charge',
          arguments: requested,
          idempotency_key: key,
          justification: 'trying to get a bigger amount approved',
        }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('APPROVAL_DENIED');
    expect(await db('transactions').count('* as c').first()).toMatchObject({ c: 0 });
  });

  it('consumes the token once and allows a same-key replay without it', async () => {
    const key = randomUUID();
    const args = business(2_500);
    const { token } = await requestToken(h.tools, h.human, 'create_charge', args, key);
    const first = await h.tools.execute('create_charge', {
      ...args,
      idempotency_key: key,
      approval_token: token,
    });
    expect(first.ok).toBe(true);

    const retry = await h.tools.execute('create_charge', {
      ...args,
      idempotency_key: key,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.meta.replayed).toBe(true);

    const newKey = randomUUID();
    const reused = await h.tools.execute('create_charge', {
      ...args,
      idempotency_key: newKey,
      approval_token: token,
    });
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error.code).toBe('APPROVAL_EXPIRED');
  });

  it('rejects an expired token', async () => {
    const key = randomUUID();
    const args = business(7_000);
    const { token, approval_id } = await requestToken(h.tools, h.human, 'create_charge', args, key);
    await db('approval_tokens')
      .where({ approval_id })
      .update({ expires_at: new Date(Date.now() - 1_000) });

    const result = await h.tools.execute('create_charge', {
      ...args,
      idempotency_key: key,
      approval_token: token,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('APPROVAL_EXPIRED');
  });
});

describe('expired approval request cleanup', () => {
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

  it('marks an expired pending request as expired so a retry can request again', async () => {
    const key = randomUUID();
    const business = {
      amount_cents: 1_100,
      currency: 'BRL',
      customer_id: 'cus_expiry',
      description: 'expiry test',
    };
    const pendingService = new ApprovalService(
      db,
      { ...h.config, approvalWaitMs: 2_000, approvalTtlMs: 5_000 },
      new PendingHumanChannel(),
    );
    const pending = pendingService.requestApproval({
      tool: 'create_charge',
      arguments: business,
      idempotency_key: key,
      justification: 'expiry test approval',
    });

    let request: { id: string } | undefined;
    for (let i = 0; i < 50 && !request; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      request = await db('approval_requests').where({ idempotency_key: key }).first();
    }
    expect(request).toBeTruthy();
    await db('approval_requests')
      .where({ id: request!.id })
      .update({ expires_at: new Date(Date.now() - 1_000) });

    await expect(pending).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    const expired = await db('approval_requests').where({ id: request!.id }).first();
    expect(expired.status).toBe('expired');
    expect(expired.decided_by).toBe('system:expiry');
  });
});

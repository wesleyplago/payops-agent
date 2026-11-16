import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb, createHarness, type Harness } from '../helpers/harness';
import { createApp } from '../../src/app';
import { assertSweepClean } from '../../src/ledger/invariant';

describe('Hono boundary', () => {
  let db: Knex;
  let h: Harness;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await setupTestDb();
    h = createHarness(db);
    app = createApp({
      db,
      config: h.config,
      approvals: h.approvals,
      tools: h.tools,
      agent: h.agent,
    });
  });

  afterAll(async () => {
    await assertSweepClean(db);
    await db.destroy();
  });

  it('health endpoints are public', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('rejects missing agent authentication', async () => {
    const response = await app.request('/v1/agent/execute', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
  });

  it('runs a read-only agent request', async () => {
    const response = await app.request('/v1/agent/execute', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.config.agentApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'show balances',
        intent: { tool: 'get_balance', arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('completed');
  });

  it('fails closed for a mutation without an approval token', async () => {
    const response = await app.request('/v1/tools/create_charge', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.config.agentApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount_cents: 100,
        currency: 'BRL',
        customer_id: 'cus_http',
        description: 'no token',
        idempotency_key: randomUUID(),
      }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('denies tools outside the allowlist', async () => {
    const response = await app.request('/v1/tools/alter_policy', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.config.agentApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TOOL_NOT_ALLOWED');
  });

  it('separates the approver secret from the agent key', async () => {
    const response = await app.request('/internal/approvals', {
      headers: { 'x-approver-key': h.config.agentApiKey },
    });
    expect(response.status).toBe(401);
  });
});

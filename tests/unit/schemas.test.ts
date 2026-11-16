import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createChargeSchema,
  refundBusinessSchema,
  sendPixSchema,
  uuidV4Schema,
} from '../../src/tools/schemas';
import { assertBusinessPolicy } from '../../src/tools/policy';
import { testConfig } from '../helpers/harness';
import { AppError } from '../../src/domain/errors';

describe('Zod tool boundary', () => {
  it('accepts UUID v4 and rejects other UUID versions', () => {
    expect(uuidV4Schema.safeParse(randomUUID()).success).toBe(true);
    expect(uuidV4Schema.safeParse('6ba7b810-9dad-11d1-80b4-00c04fd430c8').success).toBe(false);
    expect(uuidV4Schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects unknown arguments and a missing idempotency key', () => {
    const key = randomUUID();
    const base = {
      amount_cents: 1_000,
      currency: 'BRL',
      customer_id: 'cus_001',
      description: 'x',
      idempotency_key: key,
    };
    expect(createChargeSchema.safeParse(base).success).toBe(true);
    expect(createChargeSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    const { idempotency_key: _drop, ...withoutKey } = base;
    expect(createChargeSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('enforces the amount ceiling', () => {
    const result = sendPixSchema.safeParse({
      amount_cents: 1_000_000_00,
      pix_key: 'pix-demo-key',
      idempotency_key: randomUUID(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-opaque customer identifiers at the business boundary', () => {
    const result = createChargeSchema.safeParse({
      amount_cents: 100,
      currency: 'BRL',
      customer_id: 'leak@example.com',
      idempotency_key: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

describe('immutable business policy', () => {
  const config = testConfig();

  it('denies Pix destinations outside the allowlist', () => {
    expect(() =>
      assertBusinessPolicy(
        'send_pix',
        { amount_cents: 100, pix_key: 'pix-attacker-999' },
        config,
      ),
    ).toThrow(AppError);
  });

  it('denies PII in free-text arguments', () => {
    expect(() =>
      assertBusinessPolicy(
        'create_charge',
        { amount_cents: 100, description: 'CPF 123.456.789-00' },
        config,
      ),
    ).toThrow(AppError);
  });

  it('accepts a valid allowlisted Pix', () => {
    expect(() =>
      assertBusinessPolicy(
        'send_pix',
        { amount_cents: 100, pix_key: 'pix-demo-key' },
        config,
      ),
    ).not.toThrow();
  });

  it('does not mutate the policy object', () => {
    const before = JSON.stringify(config.sendPixAllowlist);
    try {
      assertBusinessPolicy('send_pix', { amount_cents: 100, pix_key: 'x' }, config);
    } catch {
      // expected
    }
    expect(JSON.stringify(config.sendPixAllowlist)).toBe(before);
  });
});

describe('refund schema', () => {
  it('requires a reason and a positive amount', () => {
    const key = randomUUID();
    expect(
      refundBusinessSchema.safeParse({
        charge_id: randomUUID(),
        amount_cents: 0,
        reason: 'x',
        idempotency_key: key,
      }).success,
    ).toBe(false);
  });
});

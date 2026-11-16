import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { setupTestDb } from '../helpers/harness';
import { assertLedgerInvariant, assertSweepClean } from '../../src/ledger/invariant';
import { newId } from '../../src/domain/ids';

describe('ledger invariant is not vacuous', () => {
  let db: Knex;

  beforeAll(async () => {
    db = await setupTestDb();
  });

  afterAll(async () => {
    await assertSweepClean(db);
    await db.destroy();
  });

  it('aborts a transaction with a single unbalanced entry', async () => {
    const txId = newId();
    const key = randomUUID();
    await expect(
      db.transaction(async (trx) => {
        await trx('transactions').insert({
          id: txId,
          idempotency_key: key,
          tool: 'send_pix',
          status: 'posted',
          amount_cents: 100,
          currency: 'BRL',
          request_hash: 'broken',
          response_json: {},
        });
        await trx('entries').insert({
          id: newId(),
          tx_id: txId,
          account_id: 'acc_cash',
          direction: 'debit',
          amount_cents: 100,
        });
        await assertLedgerInvariant(trx, txId);
      }),
    ).rejects.toMatchObject({ code: 'LEDGER_INVARIANT_VIOLATION' });

    expect(await db('transactions').where({ id: txId })).toHaveLength(0);
    expect(await db('entries').where({ tx_id: txId })).toHaveLength(0);
  });
});

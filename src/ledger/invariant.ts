import type { Knex } from 'knex';
import { AppError } from '../domain/errors';

export type LedgerViolation = {
  txId: string;
  reason: 'unbalanced' | 'too_few_entries';
  debitCents: number;
  creditCents: number;
  entryCount: number;
};

export type LedgerSweep = {
  checked_transactions: number;
  violations: LedgerViolation[];
  orphan_outbox: number;
  unpublished_outbox: number;
  outbox_payload_mismatch: number;
  checked_at: string;
};

type Row = {
  id: string;
  entry_count: number;
  debit_cents: number;
  credit_cents: number;
};

async function inspect(db: Knex, txId?: string): Promise<Row[]> {
  const query = db('transactions as t')
    .leftJoin('entries as e', 'e.tx_id', 't.id')
    .groupBy('t.id')
    .select('t.id')
    .count('e.id as entry_count')
    .sum({
      debit_cents: db.raw("CASE WHEN e.direction = 'debit' THEN e.amount_cents ELSE 0 END"),
      credit_cents: db.raw("CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE 0 END"),
    });

  if (txId) query.where('t.id', txId);
  const rows = (await query) as unknown as Row[];
  return rows.map((row) => ({
    id: row.id,
    entry_count: Number(row.entry_count),
    debit_cents: Number(row.debit_cents),
    credit_cents: Number(row.credit_cents),
  }));
}

export function toViolations(rows: Row[]): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  for (const row of rows) {
    if (row.entry_count < 2) {
      violations.push({
        txId: row.id,
        reason: 'too_few_entries',
        debitCents: row.debit_cents,
        creditCents: row.credit_cents,
        entryCount: row.entry_count,
      });
    } else if (row.debit_cents !== row.credit_cents) {
      violations.push({
        txId: row.id,
        reason: 'unbalanced',
        debitCents: row.debit_cents,
        creditCents: row.credit_cents,
        entryCount: row.entry_count,
      });
    }
  }
  return violations;
}

/**
 * The invariant is checked inside every mutation's SQL transaction (before
 * COMMIT) and again after commit. A violation aborts the mutation.
 */
export async function assertLedgerInvariant(
  db: Knex,
  txId?: string,
): Promise<void> {
  const violations = toViolations(await inspect(db, txId));
  if (violations.length > 0) {
    throw new AppError(
      'LEDGER_INVARIANT_VIOLATION',
      'ledger invariant violated: debit != credit or transaction has fewer than two entries',
      500,
      { violations },
    );
  }
}

/** Full sweep used by the suite teardown and the report script. */
export async function sweepLedger(db: Knex): Promise<LedgerSweep> {
  const rows = await inspect(db);
  const violations = toViolations(rows);

  const orphan = await db('outbox as o')
    .leftJoin('transactions as t', 't.id', 'o.tx_id')
    .whereNull('t.id')
    .count('o.id as count')
    .first();
  const unpublished = await db('outbox')
    .whereNull('published_at')
    .count('id as count')
    .first();
  const mismatch = await db('outbox as o')
    .whereRaw("o.payload->>'tx_id' IS DISTINCT FROM o.tx_id::text")
    .count('o.id as count')
    .first();

  return {
    checked_transactions: rows.length,
    violations,
    orphan_outbox: Number(orphan?.count ?? 0),
    unpublished_outbox: Number(unpublished?.count ?? 0),
    outbox_payload_mismatch: Number(mismatch?.count ?? 0),
    checked_at: new Date().toISOString(),
  };
}

export async function assertSweepClean(db: Knex): Promise<LedgerSweep> {
  const sweep = await sweepLedger(db);
  if (sweep.violations.length > 0 || sweep.orphan_outbox > 0) {
    throw new AppError(
      'LEDGER_INVARIANT_VIOLATION',
      'ledger sweep found violations or orphan outbox rows',
      500,
      sweep,
    );
  }
  return sweep;
}

import type { Knex } from 'knex';

const INVOICES = [
  { id: '11111111-1111-4111-8111-111111111111', customer_id: 'cus_001', amount_cents: 129_900, status: 'open', due_date: '2026-11-01' },
  { id: '22222222-2222-4222-8222-222222222222', customer_id: 'cus_001', amount_cents: 49_900, status: 'paid', due_date: '2026-09-01' },
  { id: '33333333-3333-4333-8333-333333333333', customer_id: 'cus_002', amount_cents: 250_000, status: 'overdue', due_date: '2026-09-15' },
  { id: '44444444-4444-4444-8444-444444444444', customer_id: 'cus_002', amount_cents: 75_000, status: 'open', due_date: '2026-11-15' },
  { id: '55555555-5555-4555-8555-555555555555', customer_id: 'cus_003', amount_cents: 10_000, status: 'void', due_date: '2026-08-01' },
  { id: '66666666-6666-4666-8666-666666666666', customer_id: 'cus_004', amount_cents: 320_000, status: 'paid', due_date: '2026-10-01' },
];

export async function seedInvoices(db: Knex): Promise<void> {
  await db('invoices').insert(INVOICES).onConflict('id').ignore();
}

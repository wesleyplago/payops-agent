import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await knex.schema.createTable('accounts', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.string('type').notNullable();
    t.string('normal_balance').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check("type in ('asset','liability','equity','revenue','expense')");
    t.check("normal_balance in ('debit','credit')");
  });

  await knex('accounts')
    .insert([
      {
        id: 'acc_cash',
        name: 'Cash / settlement',
        type: 'asset',
        normal_balance: 'debit',
      },
      {
        id: 'acc_revenue',
        name: 'Card revenue',
        type: 'revenue',
        normal_balance: 'credit',
      },
      {
        id: 'acc_refunds',
        name: 'Refunds (contra-revenue)',
        type: 'expense',
        normal_balance: 'debit',
      },
      {
        id: 'acc_pix_expense',
        name: 'Pix payouts',
        type: 'expense',
        normal_balance: 'debit',
      },
    ])
    .onConflict('id')
    .ignore();

  await knex.schema.createTable('transactions', (t) => {
    t.uuid('id').primary();
    t.string('idempotency_key').notNullable().unique();
    t.string('tool').notNullable();
    t.string('status').notNullable().defaultTo('posted');
    t.bigInteger('amount_cents').notNullable();
    t.string('currency', 3).notNullable().defaultTo('BRL');
    t.string('request_hash').notNullable();
    t.jsonb('response_json');
    t.uuid('related_tx_id').nullable().references('id').inTable('transactions');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check("tool in ('create_charge','refund','send_pix')");
    t.check("status in ('captured','posted')");
    t.check('amount_cents > 0');
  });

  await knex.schema.createTable('entries', (t) => {
    t.uuid('id').primary();
    t.uuid('tx_id').notNullable().references('id').inTable('transactions');
    t.string('account_id').notNullable().references('id').inTable('accounts');
    t.string('direction').notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check("direction in ('debit','credit')");
    t.check('amount_cents > 0');
    t.index(['tx_id'], 'entries_tx_id_idx');
    t.index(['account_id'], 'entries_account_id_idx');
  });

  await knex.schema.createTable('outbox', (t) => {
    t.uuid('id').primary();
    t.uuid('tx_id').notNullable().references('id').inTable('transactions');
    t.string('event_type').notNullable();
    t.jsonb('payload').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('published_at', { useTz: true }).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.unique(['tx_id', 'event_type']);
    t.index(['published_at'], 'outbox_unpublished_idx');
  });

  await knex.schema.createTable('invoices', (t) => {
    t.uuid('id').primary();
    t.string('customer_id').notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.string('status').notNullable().defaultTo('open');
    t.date('due_date').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check("status in ('open','paid','overdue','void')");
    t.check('amount_cents > 0');
    t.index(['customer_id'], 'invoices_customer_idx');
  });

  await knex.schema.createTable('approval_requests', (t) => {
    t.uuid('id').primary();
    t.string('tool').notNullable();
    t.jsonb('arguments').notNullable();
    t.string('args_hash').notNullable();
    t.string('idempotency_key').notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.text('justification').notNullable();
    t.string('status').notNullable().defaultTo('pending');
    t.timestamp('requested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.string('decided_by').nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.check("tool in ('create_charge','refund','send_pix')");
    t.check("status in ('pending','approved','denied','expired')");
    t.index(['status', 'requested_at'], 'approval_requests_status_idx');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX approval_requests_pending_unique
    ON approval_requests (tool, args_hash, idempotency_key)
    WHERE status = 'pending'
  `);

  await knex.schema.createTable('approval_tokens', (t) => {
    t.uuid('id').primary();
    t.uuid('approval_id').notNullable().unique().references('id').inTable('approval_requests');
    t.string('token_hash').notNullable().unique();
    t.string('tool').notNullable();
    t.string('args_hash').notNullable();
    t.string('idempotency_key').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.string('event_id').primary();
    t.jsonb('payload').notNullable();
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webhook_deliveries');
  await knex.schema.dropTableIfExists('approval_tokens');
  await knex.schema.dropTableIfExists('approval_requests');
  await knex.schema.dropTableIfExists('invoices');
  await knex.schema.dropTableIfExists('outbox');
  await knex.schema.dropTableIfExists('entries');
  await knex.schema.dropTableIfExists('transactions');
  await knex.schema.dropTableIfExists('accounts');
}

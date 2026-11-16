import type { Knex } from 'knex';
import { AppError, SimulatedCrash } from '../domain/errors';
import type { FaultPlan, ToolContext } from '../domain/context';
import type { ApprovalService } from '../services/approval';
import type { GatewayPort } from '../services/gateway';
import { assertLedgerInvariant } from './invariant';
import { ACCOUNTS } from '../domain/accounts';
import { newId, requestHash } from '../domain/ids';
import {
  businessSchemas,
  createChargeBusinessSchema,
  refundBusinessSchema,
  sendPixBusinessSchema,
  type CreateChargeArgs,
  type MutationTool,
  type RefundArgs,
  type SendPixArgs,
} from '../tools/schemas';

type EntryInput = {
  accountId: string;
  direction: 'debit' | 'credit';
  amountCents: number;
};

export type MutationData = {
  transaction_id: string;
  tool: MutationTool;
  status: 'captured' | 'posted';
  amount_cents: number;
  currency: 'BRL';
  created_at: string;
  provider_ref: string;
  related_transaction_id?: string;
  reason?: string;
};

export type MutationResult = {
  data: MutationData;
  replayed: boolean;
};

function stripToken<T extends { idempotency_key: string; approval_token?: string }>(
  args: T,
): Omit<T, 'idempotency_key' | 'approval_token'> {
  const { idempotency_key: _key, approval_token: _token, ...business } = args;
  return business;
}

export class LedgerService {
  constructor(
    private readonly db: Knex,
    private readonly approvals: ApprovalService,
    private readonly gateway: GatewayPort,
  ) {}

  async createCharge(args: CreateChargeArgs, ctx: ToolContext = {}): Promise<MutationResult> {
    const business = businessSchemas.create_charge.parse(
      stripToken(args),
    ) as import('zod').infer<typeof createChargeBusinessSchema>;
    return this.mutate(
      'create_charge',
      args,
      business,
      ctx,
      async (trx, txId, faults) => {
        const receipt = await this.gateway.capture({
          idempotencyKey: args.idempotency_key,
          amountCents: business.amount_cents,
          currency: business.currency,
          customerId: business.customer_id,
          faults,
        });
        return {
          status: 'captured' as const,
          entries: [
            { accountId: ACCOUNTS.CASH, direction: 'debit', amountCents: business.amount_cents },
            { accountId: ACCOUNTS.REVENUE, direction: 'credit', amountCents: business.amount_cents },
          ],
          providerRef: receipt.provider_ref,
          eventType: 'charge.captured',
          responseExtra: {},
          txId,
        };
      },
    );
  }

  async refund(args: RefundArgs, ctx: ToolContext = {}): Promise<MutationResult> {
    const business = businessSchemas.refund.parse(
      stripToken(args),
    ) as import('zod').infer<typeof refundBusinessSchema>;
    return this.mutate('refund', args, business, ctx, async (trx, _txId, faults) => {
      // Lock the original capture. Without this lock two concurrent refunds can
      // both read the same refunded total and jointly exceed the capture.
      const original = await trx('transactions')
        .where({ id: business.charge_id })
        .forUpdate()
        .first();
      if (
        !original ||
        original.tool !== 'create_charge' ||
        original.status !== 'captured'
      ) {
        throw new AppError('NOT_FOUND', 'original capture not found or not refundable', 404, {
          charge_id: business.charge_id,
        });
      }

      const refundedRow = await trx('transactions')
        .where({
          tool: 'refund',
          related_tx_id: original.id,
          status: 'posted',
        })
        .sum('amount_cents as total')
        .first();
      const alreadyRefunded = Number(refundedRow?.total ?? 0);
      const captured = Number(original.amount_cents);

      if (alreadyRefunded + business.amount_cents > captured) {
        const remaining = captured - alreadyRefunded;
        const code = remaining <= 0 ? 'REFUND_DUPLICATE' : 'REFUND_EXCEEDS_CAPTURE';
        throw new AppError(code, 'refund would exceed the original capture', 409, {
          charge_id: original.id,
          captured_cents: captured,
          already_refunded_cents: alreadyRefunded,
          requested_cents: business.amount_cents,
        });
      }

      const receipt = await this.gateway.refund({
        idempotencyKey: args.idempotency_key,
        amountCents: business.amount_cents,
        chargeId: business.charge_id,
        faults,
      });

      return {
        status: 'posted' as const,
        entries: [
          { accountId: ACCOUNTS.REFUNDS, direction: 'debit', amountCents: business.amount_cents },
          { accountId: ACCOUNTS.CASH, direction: 'credit', amountCents: business.amount_cents },
        ],
        providerRef: receipt.provider_ref,
        eventType: 'refund.posted',
        responseExtra: {
          related_transaction_id: original.id as string,
          reason: business.reason,
        },
        txId: _txId,
      };
    });
  }

  async sendPix(args: SendPixArgs, ctx: ToolContext = {}): Promise<MutationResult> {
    const business = businessSchemas.send_pix.parse(
      stripToken(args),
    ) as import('zod').infer<typeof sendPixBusinessSchema>;
    return this.mutate('send_pix', args, business, ctx, async (trx, txId, faults) => {
      const receipt = await this.gateway.sendPix({
        idempotencyKey: args.idempotency_key,
        amountCents: business.amount_cents,
        pixKey: business.pix_key,
        faults,
      });
      return {
        status: 'posted' as const,
        entries: [
          { accountId: ACCOUNTS.PIX_EXPENSE, direction: 'debit', amountCents: business.amount_cents },
          { accountId: ACCOUNTS.CASH, direction: 'credit', amountCents: business.amount_cents },
        ],
        providerRef: receipt.provider_ref,
        eventType: 'pix.sent',
        responseExtra: {},
        txId,
      };
    });
  }

  private async mutate(
    tool: MutationTool,
    args: CreateChargeArgs | RefundArgs | SendPixArgs,
    business: { amount_cents: number },
    ctx: ToolContext,
    prepare: (
      trx: Knex.Transaction,
      txId: string,
      faults: FaultPlan | undefined,
    ) => Promise<{
      status: 'captured' | 'posted';
      entries: EntryInput[];
      providerRef: string;
      eventType: string;
      responseExtra: Record<string, unknown>;
      txId: string;
    }>,
  ): Promise<MutationResult> {
    const argsHash = requestHash(tool, args.idempotency_key, business);
    const existing = await this.db('transactions')
      .where({ idempotency_key: args.idempotency_key })
      .first();
    if (existing) {
      return replay(existing, argsHash);
    }

    const txId = newId();
    const now = new Date();
    let result: MutationData | undefined;
    try {
      result = await this.db.transaction(async (trx) => {
        await this.approvals.consumeToken(trx, {
          token: args.approval_token,
          tool,
          idempotencyKey: args.idempotency_key,
          argsHash,
        });

        if (ctx.faults?.latencyMs) {
          await new Promise((resolve) => setTimeout(resolve, ctx.faults?.latencyMs));
        }

        const prepared = await prepare(trx, txId, ctx.faults);
        const data: MutationData = {
          transaction_id: prepared.txId,
          tool,
          status: prepared.status,
          amount_cents: business.amount_cents,
          currency: 'BRL',
          created_at: now.toISOString(),
          provider_ref: prepared.providerRef,
          ...prepared.responseExtra,
        };

        await trx('transactions').insert({
          id: prepared.txId,
          idempotency_key: args.idempotency_key,
          tool,
          status: prepared.status,
          amount_cents: business.amount_cents,
          currency: 'BRL',
          request_hash: argsHash,
          response_json: data,
          related_tx_id: (prepared.responseExtra.related_transaction_id as string | undefined) ?? null,
          created_at: now,
        });

        await trx('entries').insert(
          prepared.entries.map((entry) => ({
            id: newId(),
            tx_id: prepared.txId,
            account_id: entry.accountId,
            direction: entry.direction,
            amount_cents: entry.amountCents,
            created_at: now,
          })),
        );

        if (ctx.faults?.pauseBeforeCommitMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, ctx.faults?.pauseBeforeCommitMs),
          );
        }

        if (ctx.faults?.crashBeforeCommit) {
          // Deliberate process-death simulation: entries are already written,
          // so a non-transactional implementation would leave a partial ledger.
          throw new SimulatedCrash('process killed after entries, before commit');
        }

        const eventId = newId();
        await trx('outbox').insert({
          id: eventId,
          tx_id: prepared.txId,
          event_type: prepared.eventType,
          payload: {
            event_id: eventId,
            tx_id: prepared.txId,
            type: prepared.eventType,
            tool,
            amount_cents: business.amount_cents,
            occurred_at: now.toISOString(),
          },
          created_at: now,
        });

        // Invariant is asserted on the same connection, before COMMIT.
        await assertLedgerInvariant(trx, prepared.txId);
        return data;
      });
    } catch (err) {
      // A concurrent request with the same key may have won the race. This
      // includes the case where it consumed the single-use approval token
      // first: after rollback, the caller must still receive the winner's
      // stored response instead of a spurious approval error.
      const winner = await this.db('transactions')
        .where({ idempotency_key: args.idempotency_key })
        .first();
      if (winner) return replay(winner, argsHash);
      throw err;
    }

    if (!result) {
      throw new AppError('INTERNAL_ERROR', 'mutation produced no result', 500);
    }

    // Post-commit assertion (the second half of "verified after each mutation").
    await assertLedgerInvariant(this.db, result.transaction_id);

    if (ctx.faults?.gateway500AfterCommit) {
      throw new AppError(
        'GATEWAY_ERROR',
        'simulated gateway HTTP 500 after the ledger committed',
        502,
        { transaction_id: result.transaction_id, phase: 'after_commit' },
      );
    }
    if (ctx.faults?.crashAfterCommit) {
      throw new SimulatedCrash('process killed after commit; response was lost');
    }

    return { data: result, replayed: false };
  }
}

function replay(
  row: Record<string, unknown>,
  expectedHash: string,
): MutationResult {
  if (row.request_hash !== expectedHash) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'idempotency key was already used with different arguments',
      409,
      { idempotency_key: row.idempotency_key },
    );
  }
  if (!row.response_json) {
    throw new AppError('INTERNAL_ERROR', 'stored transaction has no response', 500);
  }
  return {
    data: row.response_json as MutationData,
    replayed: true,
  };
}

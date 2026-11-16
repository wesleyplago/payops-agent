import type { Knex } from 'knex';
import type { AppConfig } from '../config';
import { AppError } from '../domain/errors';
import { requestHash, sha256 } from '../domain/ids';
import type { RequestApprovalArgs } from '../tools/schemas';
import { businessSchemas, mutationToolSchema } from '../tools/schemas';
import { randomBytes } from 'node:crypto';
import { newId } from '../domain/ids';

export type ApprovalDecision = 'approved' | 'denied';

export type ApprovalRequestView = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  idempotency_key: string;
  justification: string;
  amount_cents: number;
  requested_at: string;
  expires_at: string;
};

export interface HumanApprovalChannel {
  readonly name: string;
  review(request: ApprovalRequestView): Promise<ApprovalDecision | 'pending'>;
}

/** Server default: wait for a real decision through the protected endpoint. */
export class PendingHumanChannel implements HumanApprovalChannel {
  readonly name = 'human:pending';
  async review(): Promise<'pending'> {
    return 'pending';
  }
}

export type IssuedApproval = {
  approval_id: string;
  status: 'approved';
  token: string;
  expires_at: string;
};

export class ApprovalService {
  constructor(
    private readonly db: Knex,
    private readonly config: AppConfig,
    private readonly channel: HumanApprovalChannel = new PendingHumanChannel(),
  ) {}

  async requestApproval(args: RequestApprovalArgs): Promise<IssuedApproval> {
    const business = businessSchemas[args.tool].parse(args.arguments);
    const argsHash = requestHash(args.tool, args.idempotency_key, business);
    const amountCents = business.amount_cents;
    const expiresAt = new Date(Date.now() + this.config.approvalTtlMs);

    let row = await this.db('approval_requests')
      .where({
        tool: args.tool,
        args_hash: argsHash,
        idempotency_key: args.idempotency_key,
        status: 'pending',
      })
      .first();

    if (!row) {
      const id = newId();
      try {
        const inserted = await this.db('approval_requests')
          .insert({
            id,
            tool: args.tool,
            arguments: business,
            args_hash: argsHash,
            idempotency_key: args.idempotency_key,
            amount_cents: amountCents,
            justification: args.justification,
            status: 'pending',
            expires_at: expiresAt,
          })
          .returning('*');
        row = inserted[0];
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        row = await this.db('approval_requests')
          .where({
            tool: args.tool,
            args_hash: argsHash,
            idempotency_key: args.idempotency_key,
            status: 'pending',
          })
          .first();
      }
    }

    if (!row) {
      throw new AppError('INTERNAL_ERROR', 'could not create approval request', 500);
    }

    const view: ApprovalRequestView = {
      id: row.id as string,
      tool: row.tool as string,
      arguments: row.arguments as Record<string, unknown>,
      idempotency_key: row.idempotency_key as string,
      justification: row.justification as string,
      amount_cents: Number(row.amount_cents),
      requested_at: new Date(row.requested_at as string).toISOString(),
      expires_at: new Date(row.expires_at as string).toISOString(),
    };

    const early = await this.channel.review(view);
    if (early === 'approved') {
      await this.decide(row.id as string, 'approved', this.channel.name);
    } else if (early === 'denied') {
      await this.decide(row.id as string, 'denied', this.channel.name);
    }

    return this.waitAndIssue(row.id as string);
  }

  async decide(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<void> {
    await this.db.transaction(async (trx) => {
      const row = await trx('approval_requests')
        .where({ id: approvalId })
        .forUpdate()
        .first();
      if (!row) throw new AppError('NOT_FOUND', 'approval not found', 404);
      if (row.status !== 'pending') return;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await trx('approval_requests')
          .where({ id: approvalId })
          .update({ status: 'expired', decided_at: new Date(), decided_by: decidedBy });
        return;
      }
      await trx('approval_requests').where({ id: approvalId }).update({
        status: decision,
        decided_at: new Date(),
        decided_by: decidedBy,
      });
    });
  }

  async waitAndIssue(approvalId: string): Promise<IssuedApproval> {
    const deadline = Date.now() + this.config.approvalWaitMs;
    for (;;) {
      const row = await this.db('approval_requests').where({ id: approvalId }).first();
      if (!row) throw new AppError('NOT_FOUND', 'approval not found', 404);

      if (row.status === 'denied') {
        throw new AppError('APPROVAL_DENIED', 'human denied the request', 403, {
          approval_id: approvalId,
        });
      }
      if (row.status === 'expired' || new Date(row.expires_at).getTime() <= Date.now()) {
        if (row.status === 'pending') {
          // Do not leave an expired request occupying the partial unique index;
          // a legitimate retry must be able to create a fresh pending request.
          await this.db('approval_requests')
            .where({ id: approvalId, status: 'pending' })
            .update({
              status: 'expired',
              decided_at: new Date(),
              decided_by: 'system:expiry',
            });
        }
        throw new AppError('APPROVAL_EXPIRED', 'approval request expired', 403, {
          approval_id: approvalId,
        });
      }
      if (row.status === 'approved') {
        return this.issueToken(row);
      }
      if (Date.now() >= deadline) {
        throw new AppError(
          'APPROVAL_REQUIRED',
          'approval is still pending; no token was issued',
          403,
          { approval_id: approvalId, status: 'pending' },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async issueToken(row: Record<string, unknown>): Promise<IssuedApproval> {
    if (new Date(row.expires_at as string).getTime() <= Date.now()) {
      throw new AppError('APPROVAL_EXPIRED', 'approval request expired', 403);
    }
    return this.db.transaction(async (trx) => {
      const current = await trx('approval_requests')
        .where({ id: row.id })
        .forUpdate()
        .first();
      if (!current || current.status !== 'approved') {
        throw new AppError('APPROVAL_REQUIRED', 'approval is not valid', 403);
      }
      const existing = await trx('approval_tokens')
        .where({ approval_id: current.id })
        .forUpdate()
        .first();
      if (existing?.used_at) {
        throw new AppError('APPROVAL_EXPIRED', 'approval token already used', 403);
      }

      const token = `apv_${randomBytes(32).toString('base64url')}`;
      const tokenHash = sha256(token);
      const ttl = Math.min(
        new Date(current.expires_at as string).getTime(),
        Date.now() + this.config.approvalTtlMs,
      );
      const expiresAt = new Date(ttl);

      if (existing) {
        await trx('approval_tokens')
          .where({ id: existing.id })
          .update({ token_hash: tokenHash, expires_at: expiresAt });
      } else {
        await trx('approval_tokens').insert({
          id: newId(),
          approval_id: current.id,
          token_hash: tokenHash,
          tool: current.tool,
          args_hash: current.args_hash,
          idempotency_key: current.idempotency_key,
          expires_at: expiresAt,
        });
      }

      return {
        approval_id: current.id as string,
        status: 'approved' as const,
        token,
        expires_at: expiresAt.toISOString(),
      };
    });
  }

  /** Consume inside the same SQL transaction as the mutation. */
  async consumeToken(
    trx: Knex.Transaction,
    input: {
      token: string | undefined;
      tool: string;
      idempotencyKey: string;
      argsHash: string;
    },
  ): Promise<void> {
    if (!input.token) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        'approval token required for every mutation',
        403,
      );
    }
    const row = await trx('approval_tokens')
      .where({ token_hash: sha256(input.token) })
      .forUpdate()
      .first();
    if (!row) {
      throw new AppError('APPROVAL_REQUIRED', 'unknown approval token', 403);
    }
    if (row.used_at) {
      throw new AppError('APPROVAL_EXPIRED', 'approval token already used', 403);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new AppError('APPROVAL_EXPIRED', 'approval token expired', 403);
    }
    if (
      row.tool !== input.tool ||
      row.idempotency_key !== input.idempotencyKey ||
      row.args_hash !== input.argsHash
    ) {
      throw new AppError(
        'APPROVAL_DENIED',
        'approval token is not bound to this tool, arguments and idempotency key',
        403,
      );
    }
    await trx('approval_tokens')
      .where({ id: row.id })
      .update({ used_at: new Date() });
  }

  getMutationTools(): string[] {
    return mutationToolSchema.options;
  }
}

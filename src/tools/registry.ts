import type { Knex } from 'knex';
import { ZodError } from 'zod';
import type { AppConfig } from '../config';
import { AppError } from '../domain/errors';
import type { ToolContext } from '../domain/context';
import { requestHash } from '../domain/ids';
import type { ApprovalService, IssuedApproval } from '../services/approval';
import type { LedgerService, MutationResult } from '../ledger/service';
import { withSpan } from '../observability/tracing';
import {
  businessSchemas,
  isMutationTool,
  toolSchemas,
  TOOL_NAMES,
  type ToolName,
} from './schemas';
import { assertBusinessPolicy } from './policy';

export type ToolSuccess = {
  ok: true;
  tool: ToolName;
  data: unknown;
  meta: {
    trace_id?: string;
    replayed?: boolean;
    approval_id?: string;
    execution_ms: number;
  };
};

export type ToolFailure = {
  ok: false;
  tool: string;
  error: { code: string; message: string; details?: unknown };
};

export type ToolResult = ToolSuccess | ToolFailure;

const TOOL_ALLOWLIST: ReadonlySet<string> = new Set(TOOL_NAMES);

function stripForBusiness(
  tool: 'create_charge' | 'refund' | 'send_pix',
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { idempotency_key: _key, approval_token: _token, ...business } = input;
  return businessSchemas[tool].parse(business) as Record<string, unknown>;
}

export class PayOpsTools {
  constructor(
    private readonly db: Knex,
    private readonly config: AppConfig,
    private readonly ledger: LedgerService,
    private readonly approvals: ApprovalService,
  ) {}

  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext = {},
  ): Promise<ToolResult> {
    const started = performance.now();
    if (!TOOL_ALLOWLIST.has(name)) {
      return {
        ok: false,
        tool: name,
        error: {
          code: 'TOOL_NOT_ALLOWED',
          message: `tool "${name}" is not in the allowlist`,
        },
      };
    }

    return withSpan(
      `tool.${name}`,
      {
        'payops.tool': name,
        'payops.source': ctx.source ?? 'unknown',
      },
      async (span) => {
        const tool = name as ToolName;
        const parsed = toolSchemas[tool].safeParse(rawInput);
        if (!parsed.success) {
          return {
            ok: false as const,
            tool,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'tool input failed Zod validation',
              details: formatZod(parsed.error),
            },
          };
        }

        try {
          const data = await this.dispatch(tool, parsed.data, ctx, span);
          const base = {
            ok: true as const,
            tool,
            data: 'data' in data ? data.data : data,
            meta: {
              trace_id: span.spanContext().traceId,
              execution_ms: round(performance.now() - started),
              ...('meta' in data ? data.meta : {}),
            },
          };
          return base;
        } catch (err) {
          if (err instanceof AppError) {
            span.setAttribute('payops.error_code', err.code);
            return {
              ok: false as const,
              tool,
              error: { code: err.code, message: err.message, details: err.details },
            };
          }
          throw err;
        }
      },
    );
  }

  private async dispatch(
    tool: ToolName,
    args: unknown,
    ctx: ToolContext,
    span: import('@opentelemetry/api').Span,
  ): Promise<
    | { data: unknown; meta?: Record<string, unknown> }
    | MutationResult
    | IssuedApproval
  > {
    if (tool === 'get_balance') {
      return { data: await this.getBalance(args as { account_id?: string }) };
    }
    if (tool === 'list_invoices') {
      return { data: await this.listInvoices(args as { status?: string; customer_id?: string; limit: number }) };
    }
    if (tool === 'request_approval') {
      const request = args as {
        tool: 'create_charge' | 'refund' | 'send_pix';
        arguments: Record<string, unknown>;
        idempotency_key: string;
        justification: string;
      };
      const business = businessSchemas[request.tool].parse(request.arguments);
      assertBusinessPolicy(request.tool, business, this.config);
      const issued = await this.approvals.requestApproval(request);
      span.setAttribute('payops.approval_id', issued.approval_id);
      return {
        data: {
          approval_id: issued.approval_id,
          status: issued.status,
          token: issued.token,
          expires_at: issued.expires_at,
        },
      };
    }

    if (!isMutationTool(tool)) {
      throw new AppError('TOOL_NOT_ALLOWED', `no handler for tool ${tool}`, 403);
    }
    const input = args as Record<string, unknown> & {
      idempotency_key: string;
      approval_token?: string;
      amount_cents: number;
    };
    const business = stripForBusiness(tool, input);
    assertBusinessPolicy(tool, business as { amount_cents: number }, this.config);

    const argsHash = requestHash(tool, input.idempotency_key, business);
    span.setAttributes({
      'payops.amount_cents': input.amount_cents,
      'payops.idempotency_key': input.idempotency_key,
      'payops.request_hash': argsHash,
      'payops.approval_token_present': Boolean(input.approval_token),
    });

    let result: MutationResult;
    if (tool === 'create_charge') {
      result = await this.ledger.createCharge(args as never, ctx);
    } else if (tool === 'refund') {
      result = await this.ledger.refund(args as never, ctx);
    } else {
      result = await this.ledger.sendPix(args as never, ctx);
    }
    span.setAttribute('payops.transaction_id', result.data.transaction_id);
    span.setAttribute('payops.replayed', result.replayed);
    return { data: result.data, meta: { replayed: result.replayed } };
  }

  async getBalance(args: { account_id?: string }): Promise<{
    as_of: string;
    accounts: Array<{
      account_id: string;
      name: string;
      type: string;
      normal_balance: string;
      balance_cents: number;
    }>;
  }> {
    const query = this.db('accounts as a')
      .leftJoin('entries as e', 'e.account_id', 'a.id')
      .groupBy('a.id', 'a.name', 'a.type', 'a.normal_balance')
      .select(
        'a.id as account_id',
        'a.name',
        'a.type',
        'a.normal_balance',
        this.db.raw(
          `COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount_cents ELSE -e.amount_cents END), 0)::bigint AS net_debit`,
        ),
      );
    if (args.account_id) query.where('a.id', args.account_id);
    const rows = await query;
    if (args.account_id && rows.length === 0) {
      throw new AppError('NOT_FOUND', 'account not found', 404);
    }
    return {
      as_of: new Date().toISOString(),
      accounts: rows.map((row) => {
        const netDebit = Number((row as { net_debit: number }).net_debit);
        return {
          account_id: String(row.account_id),
          name: String(row.name),
          type: String(row.type),
          normal_balance: String(row.normal_balance),
          balance_cents:
            row.normal_balance === 'debit' ? netDebit : -netDebit,
        };
      }),
    };
  }

  async listInvoices(args: {
    status?: string;
    customer_id?: string;
    limit: number;
  }): Promise<{
    invoices: Array<{
      id: string;
      customer_id: string;
      amount_cents: number;
      status: string;
      due_date: string;
    }>;
  }> {
    const query = this.db('invoices')
      .select('id', 'customer_id', 'amount_cents', 'status', 'due_date')
      .orderBy('due_date', 'asc')
      .limit(args.limit);
    if (args.status) query.where('status', args.status);
    if (args.customer_id) query.where('customer_id', args.customer_id);
    const rows = await query;
    return {
      invoices: rows.map((row) => ({
        id: String(row.id),
        customer_id: String(row.customer_id),
        amount_cents: Number(row.amount_cents),
        status: String(row.status),
        due_date: String(row.due_date),
      })),
    };
  }
}

function formatZod(error: ZodError): unknown {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

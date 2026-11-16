import { z } from 'zod';
import type { AppConfig } from '../config';
import { AppError } from '../domain/errors';
import type { ToolContext } from '../domain/context';
import { canonicalJson } from '../domain/ids';
import { redactDeep, redactPii } from '../domain/pii';
import { currentTraceId } from '../observability/tracing';
import type { PayOpsTools, ToolResult } from '../tools/registry';
import {
  businessSchemas,
  isMutationTool,
  type MutationTool,
  uuidV4Schema,
} from '../tools/schemas';
import { scanDocuments, type KbDocument, type ScannedDocuments } from './documents';
import type { AgentTool, DecisionModel, ModelDecision, ModelUsage } from './model';

export const AgentRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    intent: z
      .object({
        tool: z.enum([
          'create_charge',
          'refund',
          'send_pix',
          'get_balance',
          'list_invoices',
        ]),
        arguments: z.record(z.unknown()),
        idempotency_key: uuidV4Schema.optional(),
      })
      .strict(),
    documents: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            title: z.string().min(1).max(200),
            content: z.string().max(20_000),
            source: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict();

export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export type ToolCallTrace = {
  tool: string;
  ok: boolean;
  error_code?: string;
  replayed?: boolean;
  approval_id?: string;
};

export type AgentResult = {
  status: 'completed' | 'failed' | 'denied';
  answer: string;
  data?: unknown;
  tool_calls: ToolCallTrace[];
  documents: {
    scanned: number;
    suspicious: number;
    quarantined: number;
    pii_documents: number;
    categories: Record<string, number>;
    ids: Array<{ id: string; quarantine: boolean; categories: string[] }>;
  };
  trace_id?: string;
  model_path: 'bounded-intent' | 'forced-compromised';
  usage: ModelUsage;
  cost_usd: number;
  pii_redactions: number;
};

export type ExecuteOptions = {
  /** Test-only: emulate a fully compromised model that chose this action. */
  forcedDecision?: ModelDecision;
  /** Test-only: emulate a compromised model that emits this raw answer. */
  forcedAnswer?: string;
};

export class AgentRuntime {
  constructor(
    private readonly tools: PayOpsTools,
    private readonly model: DecisionModel,
    private readonly config: AppConfig,
  ) {}

  async execute(
    rawRequest: AgentRequest,
    ctx: ToolContext = {},
    options: ExecuteOptions = {},
  ): Promise<AgentResult> {
    const request = AgentRequestSchema.parse(rawRequest);
    const scan = scanDocuments(request.documents as KbDocument[]);

    let decision: ModelDecision;
    let usage: ModelUsage;
    let modelPath: AgentResult['model_path'] = 'bounded-intent';

    if (options.forcedDecision) {
      decision = options.forcedDecision;
      usage = { input_tokens: 0, output_tokens: 0, model: 'forced-compromised' };
      modelPath = 'forced-compromised';
    } else {
      const modelResult = await this.model.decide({
        instruction: request.message,
        intent: {
          tool: request.intent.tool,
          arguments: request.intent.arguments,
          idempotency_key: request.intent.idempotency_key,
          justification: 'operator-intent',
          rationale: 'operator-intent',
        },
        documents: scan.data_channel,
      });
      decision = modelResult.decision;
      usage = modelResult.usage;
    }

    if (!isAgentTool(decision.tool)) {
      throw new AppError('TOOL_NOT_ALLOWED', 'model selected a non-allowlisted tool', 403);
    }

    const toolCalls: ToolCallTrace[] = [];
    let result: ToolResult | undefined;
    let status: AgentResult['status'] = 'completed';

    try {
      if (isMutationTool(decision.tool)) {
        const business = businessSchemas[decision.tool].parse(decision.arguments);
        const idempotencyKey = decision.idempotency_key ?? request.intent.idempotency_key;
        if (!idempotencyKey) {
          throw new AppError(
            'VALIDATION_ERROR',
            'mutating intents require a caller-supplied UUID v4 idempotency_key',
            400,
          );
        }
        const decisionBusiness = businessSchemas[decision.tool].parse(decision.arguments);
        if (canonicalJson(business) !== canonicalJson(decisionBusiness)) {
          throw new AppError(
            'VALIDATION_ERROR',
            'model changed or added business arguments after intent validation',
            400,
          );
        }

        const approval = await this.tools.execute(
          'request_approval',
          {
            tool: decision.tool,
            arguments: business,
            idempotency_key: idempotencyKey,
            justification: approvalJustification(decision.tool),
          },
          ctx,
        );
        toolCalls.push(toTrace('request_approval', approval));
        if (!approval.ok) {
          status = approval.error.code === 'APPROVAL_DENIED' ? 'denied' : 'failed';
          return this.finish(request, scan, toolCalls, undefined, status, undefined, usage, modelPath, options);
        }
        const token = (approval.data as { token?: string }).token;
        if (!token) {
          status = 'denied';
          return this.finish(request, scan, toolCalls, undefined, status, undefined, usage, modelPath, options);
        }

        result = await this.tools.execute(
          decision.tool,
          { ...business, idempotency_key: idempotencyKey, approval_token: token },
          ctx,
        );
        toolCalls.push(toTrace(decision.tool, result));
      } else {
        result = await this.tools.execute(decision.tool, decision.arguments, ctx);
        toolCalls.push(toTrace(decision.tool, result));
      }
    } catch (err) {
      if (err instanceof AppError) {
        toolCalls.push({
          tool: decision.tool,
          ok: false,
          error_code: err.code,
        });
        status = err.code.startsWith('APPROVAL') ? 'denied' : 'failed';
        return this.finish(request, scan, toolCalls, undefined, status, undefined, usage, modelPath, options);
      }
      throw err;
    }

    if (!result) {
      throw new AppError('INTERNAL_ERROR', 'tool execution returned no result', 500);
    }
    if (!result.ok) {
      status = result.error.code.startsWith('APPROVAL') ? 'denied' : 'failed';
    }

    return this.finish(
      request,
      scan,
      toolCalls,
      result.ok ? result.data : undefined,
      status,
      result.ok ? undefined : result.error,
      usage,
      modelPath,
      options,
    );
  }

  private finish(
    request: AgentRequest,
    scan: ScannedDocuments,
    toolCalls: ToolCallTrace[],
    data: unknown,
    status: AgentResult['status'],
    error: { code: string; message: string } | undefined,
    usage: ModelUsage,
    modelPath: AgentResult['model_path'],
    options: ExecuteOptions,
  ): AgentResult {
    let answer =
      options.forcedAnswer ??
      composeAnswer(request.intent.tool, status, data, error);
    const redactedAnswer = redactPii(answer);
    const redactedData = redactDeep(data);

    const categories: Record<string, number> = {};
    for (const doc of scan.documents) {
      for (const category of doc.categories) {
        categories[category] = (categories[category] ?? 0) + 1;
      }
    }

    return {
      status,
      answer: redactedAnswer.text,
      data: redactedData.value,
      tool_calls: toolCalls,
      documents: {
        scanned: scan.documents.length,
        suspicious: scan.suspicious_count,
        quarantined: scan.quarantined_count,
        pii_documents: scan.pii_documents,
        categories,
        ids: scan.documents.map((doc) => ({
          id: doc.id,
          quarantine: doc.quarantine,
          categories: doc.categories,
        })),
      },
      trace_id: currentTraceId(),
      model_path: modelPath,
      usage,
      cost_usd: costOf(usage, this.config),
      pii_redactions: redactedAnswer.redactions + redactedData.redactions,
    };
  }
}

function isAgentTool(value: string): value is AgentTool {
  return [
    'create_charge',
    'refund',
    'send_pix',
    'get_balance',
    'list_invoices',
  ].includes(value);
}

function toTrace(tool: string, result: ToolResult): ToolCallTrace {
  if (result.ok) {
    return {
      tool,
      ok: true,
      replayed: result.meta.replayed,
      approval_id: result.meta.approval_id,
    };
  }
  return { tool, ok: false, error_code: result.error.code };
}

function approvalJustification(tool: MutationTool): string {
  return `Operator requested ${tool}; approve only this exact tool, amount, destination and idempotency key.`;
}

function composeAnswer(
  tool: AgentTool,
  status: AgentResult['status'],
  data: unknown,
  error: { code: string; message: string } | undefined,
): string {
  if (status !== 'completed') {
    return `Ação não executada. Código: ${error?.code ?? 'UNKNOWN'}.`;
  }
  if (tool === 'create_charge') {
    const d = data as { amount_cents: number; transaction_id: string; replayed?: boolean };
    return `Cobrança registrada: ${format(d.amount_cents)} (transação ${d.transaction_id}).`;
  }
  if (tool === 'refund') {
    const d = data as { amount_cents: number; transaction_id: string };
    return `Estorno registrado: ${format(d.amount_cents)} (transação ${d.transaction_id}).`;
  }
  if (tool === 'send_pix') {
    const d = data as { amount_cents: number; transaction_id: string };
    return `Pix enviado: ${format(d.amount_cents)} (transação ${d.transaction_id}).`;
  }
  if (tool === 'get_balance') {
    const d = data as { accounts: Array<{ name: string; balance_cents: number }> };
    return `Saldos: ${d.accounts.map((a) => `${a.name}=${format(a.balance_cents)}`).join('; ')}.`;
  }
  const d = data as { invoices: Array<{ id: string; amount_cents: number; status: string }> };
  return `${d.invoices.length} fatura(s) encontrada(s).`;
}

function costOf(usage: ModelUsage, config: AppConfig): number {
  const input = (usage.input_tokens / 1_000_000) * config.llmInputPricePer1M;
  const output = (usage.output_tokens / 1_000_000) * config.llmOutputPricePer1M;
  return Math.round((input + output) * 100_000_000) / 100_000_000;
}

function format(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    cents / 100,
  );
}

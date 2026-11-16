import { randomUUID } from 'node:crypto';
import type { Harness } from './harness';
import type { AgentRequest } from '../agent/runtime';
import type { FaultPlan } from '../domain/context';
import { SimulatedCrash } from '../domain/errors';
import { sweepLedger } from '../ledger/invariant';
import { WebhookReceiver } from '../services/webhook';

export type Scenario =
  | 'none'
  | 'timeout_at_2s'
  | 'duplicate_webhook'
  | 'retry_after_success'
  | 'gateway_500_before_commit'
  | 'gateway_500_after_commit'
  | 'process_death_before_commit'
  | 'process_death_after_commit';

export type ChaosOptions = {
  runs: number;
  concurrency: number;
  timeoutMs: number;
  seed?: number;
};

export type ChaosExecution = {
  tool: string;
  scenario: Scenario;
  eventual_ok: boolean;
  first_status: string;
  retry_status?: string;
  duration_ms: number;
  timed_out: boolean;
  duplicate_webhook: boolean;
  error_codes: string[];
  tx_count: number;
  logical_key: string;
};

export type ChaosReport = {
  generated_at: string;
  config: {
    runs: number;
    concurrency: number;
    timeout_ms: number;
    seed: number;
    model: string;
    database: 'postgres';
    wall_clock_ms?: number;
  };
  summary: {
    executions: number;
    successful_executions: number;
    unrecovered_failures: number;
    duplicate_charges: number;
    duplicate_charge_rate: number;
    ledger_invariant_violations: number;
    orphan_outbox: number;
    unpublished_outbox: number;
    outbox_payload_mismatch: number;
    duplicate_webhooks_handled: number;
    p95_turn_ms: number;
    p95_turn_ms_excluding_timeouts: number;
    total_llm_tokens: number;
    cost_per_decision_usd: number;
    cost_basis: string;
  };
  integrity: {
    checked_transactions: number;
    ledger_violations: unknown[];
    gateway: { calls: number; deduplicated: number; failures: number };
  };
  by_scenario: Array<{
    scenario: Scenario;
    executions: number;
    recovered: number;
    unrecovered: number;
    duplicate_charges: number;
    p95_ms: number;
    timed_out: number;
  }>;
  by_tool: Array<{ tool: string; executions: number; failed: number }>;
  approval_reviews: { total: number; denied: number };
  errors: Array<{ code: string; count: number }>;
  samples: ChaosExecution[];
};

const SCENARIOS: Scenario[] = [
  'none',
  'none',
  'none',
  'none',
  'timeout_at_2s',
  'duplicate_webhook',
  'retry_after_success',
  'gateway_500_before_commit',
  'gateway_500_after_commit',
  'process_death_before_commit',
  'process_death_after_commit',
  'none',
];

export async function runChaos(
  harness: Harness,
  options: ChaosOptions,
): Promise<ChaosReport> {
  const seed = options.seed ?? 20261023;
  const random = mulberry32(seed);
  const receiver = new WebhookReceiver(harness.db);
  const baselineCharges = await createBaselineCharges(harness, 100, 20_000);
  const remaining = new Map<string, number>(baselineCharges.map((id) => [id, 20_000]));

  const executions: ChaosExecution[] = [];
  const resultKeys: Array<{ key: string; tool: string; scenario: Scenario; index: number }> = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= options.runs) return;
      const run = buildRun(harness, index, random, baselineCharges, remaining);
      const scenario = run.tool === 'get_balance' || run.tool === 'list_invoices' ? 'none' : pickScenario(random);
      const started = performance.now();
      const outcome = await executeWithChaos(harness, run.request, run.expected, scenario, options.timeoutMs, receiver);
      const duration = performance.now() - started;
      const execution: ChaosExecution = {
        tool: run.tool,
        scenario,
        eventual_ok: outcome.eventualOk,
        first_status: outcome.firstStatus,
        retry_status: outcome.retryStatus,
        duration_ms: round(duration),
        timed_out: outcome.timedOut,
        duplicate_webhook: outcome.duplicateWebhook,
        error_codes: outcome.errorCodes,
        tx_count: 0,
        logical_key: run.key,
      };
      executions.push(execution);
      if (run.tool !== 'get_balance' && run.tool !== 'list_invoices') {
        resultKeys.push({ key: run.key, tool: run.tool, scenario, index });
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  const rows = await harness.db('transactions')
    .whereIn('idempotency_key', resultKeys.map((r) => r.key))
    .select('id', 'idempotency_key', 'tool', 'amount_cents');
  const byKey = new Map<string, number>();
  for (const row of rows) {
    byKey.set(String(row.idempotency_key), (byKey.get(String(row.idempotency_key)) ?? 0) + 1);
  }
  const executionByKey = new Map(executions.map((execution) => [execution.logical_key, execution]));
  for (const result of resultKeys) {
    const execution = executionByKey.get(result.key);
    if (execution) execution.tx_count = byKey.get(result.key) ?? 0;
  }

  // Drain the outbox so the report distinguishes an orphan event from an
  // event that is simply waiting for delivery.
  const unpublished = await harness.db('outbox').whereNull('published_at').select('*');
  for (const row of unpublished) {
    await receiver.receive(row.payload);
    await harness.db('outbox').where({ id: row.id }).update({
      published_at: new Date(),
      attempts: harness.db.raw('attempts + 1'),
    });
  }

  const sweep = await sweepLedger(harness.db);
  const charges = executions.filter((e) => e.tool === 'create_charge');
  const duplicateCharges = charges.filter((e) => e.tx_count > 1).length;
  const unrecovered = executions.filter((e) => !e.eventual_ok).length;
  const allDurations = executions.map((e) => e.duration_ms);
  const nonTimeoutDurations = executions.filter((e) => !e.timed_out).map((e) => e.duration_ms);
  const totalTokens = 0;
  const scenarioRows = [...new Set(executions.map((e) => e.scenario))].map((scenario) => {
    const group = executions.filter((e) => e.scenario === scenario);
    return {
      scenario,
      executions: group.length,
      recovered: group.filter((e) => e.eventual_ok && (e.retry_status || e.scenario === 'timeout_at_2s' || e.duplicate_webhook)).length,
      unrecovered: group.filter((e) => !e.eventual_ok).length,
      duplicate_charges: group.filter((e) => e.tool === 'create_charge' && e.tx_count > 1).length,
      p95_ms: p95(group.map((e) => e.duration_ms)),
      timed_out: group.filter((e) => e.timed_out).length,
    };
  });

  const toolNames = [...new Set(executions.map((e) => e.tool))];
  const errors = new Map<string, number>();
  for (const execution of executions) {
    for (const code of execution.error_codes) {
      errors.set(code, (errors.get(code) ?? 0) + 1);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    config: {
      runs: options.runs,
      concurrency: options.concurrency,
      timeout_ms: options.timeoutMs,
      seed,
      model: 'bounded-intent-deterministic',
      database: 'postgres',
    },
    summary: {
      executions: executions.length,
      successful_executions: executions.filter((e) => e.eventual_ok).length,
      unrecovered_failures: unrecovered,
      duplicate_charges: duplicateCharges,
      duplicate_charge_rate: charges.length === 0 ? 0 : duplicateCharges / charges.length,
      ledger_invariant_violations: sweep.violations.length,
      orphan_outbox: sweep.orphan_outbox,
      unpublished_outbox: sweep.unpublished_outbox,
      outbox_payload_mismatch: sweep.outbox_payload_mismatch,
      duplicate_webhooks_handled: receiver.stats.duplicates,
      p95_turn_ms: p95(allDurations),
      p95_turn_ms_excluding_timeouts: p95(nonTimeoutDurations),
      total_llm_tokens: totalTokens,
      cost_per_decision_usd: 0,
      cost_basis: 'no external inference: deterministic bounded-intent model reports 0 tokens; adapter supports provider usage',
    },
    integrity: {
      checked_transactions: sweep.checked_transactions,
      ledger_violations: sweep.violations,
      gateway: { ...harness.gateway.stats },
    },
    by_scenario: scenarioRows,
    by_tool: toolNames.map((tool) => ({
      tool,
      executions: executions.filter((e) => e.tool === tool).length,
      failed: executions.filter((e) => e.tool === tool && !e.eventual_ok).length,
    })),
    approval_reviews: {
      total: harness.human.reviews.length,
      denied: harness.human.reviews.filter((r) => !r.approved).length,
    },
    errors: [...errors.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    samples: executions.slice(0, 10),
  };
}

type BuiltRun = {
  key: string;
  tool: string;
  request: AgentRequest;
  expected: import('../chaos/human').ExpectedAction | null;
};

function buildRun(
  harness: Harness,
  index: number,
  random: () => number,
  charges: string[],
  remaining: Map<string, number>,
): BuiltRun {
  const roll = random();
  if (roll < 0.4) {
    const key = randomUUID();
    const amount = 1_000 + Math.floor(random() * 49_000);
    const business = {
      amount_cents: amount,
      currency: 'BRL' as const,
      customer_id: `cus_chaos_${index}`,
      description: `chaos charge ${index}`,
    };
    return {
      key,
      tool: 'create_charge',
      request: {
        message: `create charge ${index}`,
        intent: { tool: 'create_charge', arguments: business, idempotency_key: key },
        documents: [],
      },
      expected: { tool: 'create_charge', arguments: business, idempotency_key: key },
    };
  }
  if (roll < 0.65) {
    const key = randomUUID();
    const amount = 100 + Math.floor(random() * 900);
    const candidates = charges.filter((id) => (remaining.get(id) ?? 0) >= amount);
    const chargeId = candidates[Math.floor(random() * candidates.length)] ?? charges[0]!;
    remaining.set(chargeId, (remaining.get(chargeId) ?? 0) - amount);
    const business = {
      charge_id: chargeId,
      amount_cents: amount,
      reason: `chaos refund ${index}`,
    };
    return {
      key,
      tool: 'refund',
      request: {
        message: `refund ${index}`,
        intent: { tool: 'refund', arguments: business, idempotency_key: key },
        documents: [],
      },
      expected: { tool: 'refund', arguments: business, idempotency_key: key },
    };
  }
  if (roll < 0.8) {
    const key = randomUUID();
    const business = {
      amount_cents: 500 + Math.floor(random() * 4_500),
      pix_key: random() < 0.5 ? 'pix-vendor-001' : 'pix-vendor-002',
      description: `chaos pix ${index}`,
    };
    return {
      key,
      tool: 'send_pix',
      request: {
        message: `send pix ${index}`,
        intent: { tool: 'send_pix', arguments: business, idempotency_key: key },
        documents: [],
      },
      expected: { tool: 'send_pix', arguments: business, idempotency_key: key },
    };
  }
  if (roll < 0.9) {
    const key = randomUUID();
    return {
      key,
      tool: 'get_balance',
      request: {
        message: 'balance',
        intent: { tool: 'get_balance', arguments: {}, idempotency_key: key },
        documents: [],
      },
      expected: null,
    };
  }
  const key = randomUUID();
  return {
    key,
    tool: 'list_invoices',
    request: {
      message: 'invoices',
      intent: { tool: 'list_invoices', arguments: { limit: 5 }, idempotency_key: key },
      documents: [],
    },
    expected: null,
  };
}

function pickScenario(random: () => number): Scenario {
  return SCENARIOS[Math.floor(random() * SCENARIOS.length)]!;
}

type ChaosOutcome = {
  eventualOk: boolean;
  firstStatus: string;
  retryStatus?: string;
  timedOut: boolean;
  duplicateWebhook: boolean;
  errorCodes: string[];
};

async function executeWithChaos(
  harness: Harness,
  request: AgentRequest,
  expected: import('../chaos/human').ExpectedAction | null,
  scenario: Scenario,
  timeoutMs: number,
  receiver: WebhookReceiver,
): Promise<ChaosOutcome> {
  const errorCodes: string[] = [];
  let timedOut = false;
  let duplicateWebhook = false;
  let firstStatus = 'not_run';
  let retryStatus: string | undefined;
  let eventualOk = false;

  const execute = (faults?: FaultPlan) =>
    harness.human.storage.run(expected, () =>
      harness.agent.execute(request, { source: `chaos:${scenario}`, faults }),
    );

  const faultsFor: Record<Scenario, FaultPlan | undefined> = {
    none: undefined,
    timeout_at_2s: { latencyMs: timeoutMs + 300 },
    duplicate_webhook: undefined,
    retry_after_success: undefined,
    gateway_500_before_commit: { gateway500BeforeCommit: true },
    gateway_500_after_commit: { gateway500AfterCommit: true },
    process_death_before_commit: { crashBeforeCommit: true },
    process_death_after_commit: { crashAfterCommit: true },
  };

  const first = await capture(() => execute(faultsFor[scenario]), scenario === 'timeout_at_2s' ? timeoutMs : undefined);
  if (first.timedOut) {
    timedOut = true;
    firstStatus = 'timeout';
    errorCodes.push('CLIENT_TIMEOUT');
  } else if (first.error) {
    firstStatus = 'exception';
    errorCodes.push(classifyError(first.error));
  } else {
    firstStatus = first.value?.status ?? 'unknown';
    collectErrors(first.value, errorCodes);
  }

  const shouldRetry =
    scenario === 'timeout_at_2s' ||
    scenario === 'retry_after_success' ||
    scenario === 'gateway_500_before_commit' ||
    scenario === 'gateway_500_after_commit' ||
    scenario === 'process_death_before_commit' ||
    scenario === 'process_death_after_commit';

  if (scenario === 'duplicate_webhook') {
    const tx = await harness.db('transactions').where({ idempotency_key: request.intent.idempotency_key! }).first();
    if (tx) {
      const outbox = await harness.db('outbox').where({ tx_id: tx.id }).first();
      if (outbox) {
        await receiver.receive(outbox.payload);
        const duplicate = await receiver.receive(outbox.payload);
        duplicateWebhook = duplicate.duplicate;
        if (!duplicate.duplicate) errorCodes.push('WEBHOOK_NOT_DEDUPED');
        await harness.db('outbox').where({ id: outbox.id }).update({ published_at: new Date() });
      }
    }
  }

  if (shouldRetry) {
    const retry = await capture(() => execute(undefined));
    if (retry.error) {
      retryStatus = 'exception';
      errorCodes.push(classifyError(retry.error));
    } else {
      retryStatus = retry.value?.status ?? 'unknown';
      collectErrors(retry.value, errorCodes);
    }
  }

  const tx = await harness.db('transactions').where({ idempotency_key: request.intent.idempotency_key! }).first();
  const statuses = [firstStatus, retryStatus].filter(Boolean);
  const readTool = request.intent.tool === 'get_balance' || request.intent.tool === 'list_invoices';
  eventualOk = readTool
    ? firstStatus === 'completed' && !first.timedOut
    : Boolean(tx) && statuses.includes('completed');
  if (!eventualOk) errorCodes.push('UNRECOVERED');

  return { eventualOk, firstStatus, retryStatus, timedOut, duplicateWebhook, errorCodes };
}

async function capture(
  fn: () => Promise<import('../agent/runtime').AgentResult>,
  timeoutMs?: number,
): Promise<
  | { value?: import('../agent/runtime').AgentResult; error?: unknown; timedOut: boolean }
> {
  const promise = fn().then(
    (value) => ({ value, timedOut: false as const }),
    (error) => ({ error, timedOut: false as const }),
  );
  if (!timeoutMs) return promise;
  const timeout = new Promise<{ timedOut: true }>((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), timeoutMs),
  );
  const result = await Promise.race([promise, timeout]);
  if ('timedOut' in result && result.timedOut) {
    // Let the in-flight operation finish; it may have committed.
    await promise.catch(() => undefined);
    return { timedOut: true };
  }
  return result as { value?: import('../agent/runtime').AgentResult; error?: unknown; timedOut: boolean };
}

function collectErrors(
  result: import('../agent/runtime').AgentResult | undefined,
  codes: string[],
): void {
  if (!result) return;
  for (const call of result.tool_calls) {
    if (!call.ok && call.error_code) codes.push(call.error_code);
  }
}

function classifyError(error: unknown): string {
  if (error instanceof SimulatedCrash) return 'SIMULATED_PROCESS_DEATH';
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return 'EXCEPTION';
}

async function createBaselineCharges(
  harness: Harness,
  count: number,
  amount: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = randomUUID();
    const business = {
      amount_cents: amount,
      currency: 'BRL' as const,
      customer_id: `cus_baseline_${i}`,
      description: `baseline charge ${i}`,
    };
    const result = await harness.human.storage.run(
      { tool: 'create_charge', arguments: business, idempotency_key: key },
      async () => {
        const approval = await harness.tools.execute('request_approval', {
          tool: 'create_charge',
          arguments: business,
          idempotency_key: key,
          justification: `baseline charge ${i}`,
        });
        if (!approval.ok) throw new Error(`baseline approval failed: ${approval.error.code}`);
        const token = (approval.data as { token: string }).token;
        return harness.tools.execute('create_charge', {
          ...business,
          idempotency_key: key,
          approval_token: token,
        });
      },
    );
    if (!result.ok) throw new Error(`baseline charge failed: ${result.error.code}`);
    ids.push((result.data as { transaction_id: string }).transaction_id);
  }
  return ids;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return round(sorted[index]!);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

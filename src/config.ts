import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .default('postgres://payops:payops@localhost:5432/payops'),
  APPROVER_SECRET: z.string().min(8).default('local-approver-secret-change-me'),
  AGENT_API_KEY: z.string().min(8).default('local-agent-key-change-me'),
  APPROVAL_TTL_MS: z.coerce.number().int().positive().default(60_000),
  APPROVAL_WAIT_MS: z.coerce.number().int().positive().default(15_000),
  OTEL_SERVICE_NAME: z.string().default('payops-agent'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_TRACE_FILE: z.string().optional(),
  SEND_PIX_ALLOWLIST: z
    .string()
    .default('pix-demo-key,pix-vendor-001,pix-vendor-002'),
  LLM_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
  LLM_API_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  ),
  LLM_MODEL: z.string().default('deepseek-chat'),
  LLM_INPUT_PRICE_PER_1M: z.coerce.number().nonnegative().default(0),
  LLM_OUTPUT_PRICE_PER_1M: z.coerce.number().nonnegative().default(0),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
});

export type AppConfig = {
  port: number;
  databaseUrl: string;
  approverSecret: string;
  agentApiKey: string;
  approvalTtlMs: number;
  approvalWaitMs: number;
  otelServiceName: string;
  otelExporterEndpoint?: string;
  otelTraceFile?: string;
  sendPixAllowlist: readonly string[];
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel: string;
  llmInputPricePer1M: number;
  llmOutputPricePer1M: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  dbPoolMax: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    approverSecret: parsed.APPROVER_SECRET,
    agentApiKey: parsed.AGENT_API_KEY,
    approvalTtlMs: parsed.APPROVAL_TTL_MS,
    approvalWaitMs: parsed.APPROVAL_WAIT_MS,
    otelServiceName: parsed.OTEL_SERVICE_NAME,
    otelExporterEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelTraceFile: parsed.OTEL_TRACE_FILE,
    sendPixAllowlist: parsed.SEND_PIX_ALLOWLIST.split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    llmBaseUrl: parsed.LLM_BASE_URL,
    llmApiKey: parsed.LLM_API_KEY,
    llmModel: parsed.LLM_MODEL,
    llmInputPricePer1M: parsed.LLM_INPUT_PRICE_PER_1M,
    llmOutputPricePer1M: parsed.LLM_OUTPUT_PRICE_PER_1M,
    logLevel: parsed.LOG_LEVEL,
    dbPoolMax: parsed.DB_POOL_MAX,
  };
}

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://payops:payops@localhost:5432/payops_test';

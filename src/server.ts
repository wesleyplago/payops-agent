import path from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { seedInvoices } from './db/seed';
import { startTelemetry } from './observability/otel';
import { ApprovalService, PendingHumanChannel } from './services/approval';
import { SimulatedGateway } from './services/gateway';
import { LedgerService } from './ledger/service';
import { PayOpsTools } from './tools/registry';
import { AgentRuntime } from './agent/runtime';
import { BoundedIntentModel } from './agent/model';
import { OpenAICompatibleModel } from './agent/llm-model';
import { createApp } from './app';

const config = loadConfig();
const telemetry = startTelemetry(config);
const db = createDb({ url: config.databaseUrl, poolMax: config.dbPoolMax });

await runMigrations(db, path.resolve('migrations'));
await seedInvoices(db);

const gateway = new SimulatedGateway();
const approvals = new ApprovalService(db, config, new PendingHumanChannel());
const ledger = new LedgerService(db, approvals, gateway);
const tools = new PayOpsTools(db, config, ledger, approvals);
const model = config.llmBaseUrl
  ? new OpenAICompatibleModel({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
    })
  : new BoundedIntentModel();
const agent = new AgentRuntime(tools, model, config);
const app = createApp({ db, config, approvals, tools, agent });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'payops-agent listening',
      port: info.port,
      otel: config.otelExporterEndpoint ?? 'file-only',
    }),
  );
});

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await telemetry.shutdown();
  await db.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

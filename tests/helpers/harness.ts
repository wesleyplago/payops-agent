import type { Knex } from 'knex';
import type { AppConfig } from '../../src/config';
import { loadConfig, TEST_DATABASE_URL } from '../../src/config';
import { createDb, runMigrations, truncateAll } from '../../src/db/client';
import { seedInvoices } from '../../src/db/seed';
import type { MutationTool } from '../../src/tools/schemas';
import { createHarness as createChaosHarness, type Harness } from '../../src/chaos/harness';
import type { PayOpsTools } from '../../src/tools/registry';
import type { RoutedHumanChannel } from '../../src/chaos/human';
export { RoutedHumanChannel } from '../../src/chaos/human';
export type { Harness };
import path from 'node:path';

export async function setupTestDb(): Promise<Knex> {
  const db = createDb({ url: TEST_DATABASE_URL, poolMax: 50, applicationName: 'payops-tests' });
  await runMigrations(db, path.resolve('migrations'));
  await truncateAll(db);
  await seedInvoices(db);
  return db;
}

export function testConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    APPROVER_SECRET: 'test-approver-secret',
    AGENT_API_KEY: 'test-agent-key-1234',
    APPROVAL_TTL_MS: '10000',
    APPROVAL_WAIT_MS: '2000',
    SEND_PIX_ALLOWLIST: 'pix-demo-key,pix-vendor-001,pix-vendor-002',
    LOG_LEVEL: 'error',
  });
}

export function createHarness(db: Knex): Harness {
  return createChaosHarness(db, testConfig());
}

export async function requestToken(
  tools: PayOpsTools,
  human: RoutedHumanChannel,
  tool: MutationTool,
  business: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ token: string; approval_id: string }> {
  return human.storage.run({ tool, arguments: business, idempotency_key: idempotencyKey }, async () => {
    const result = await tools.execute('request_approval', {
      tool,
      arguments: business,
      idempotency_key: idempotencyKey,
      justification: `test approval for ${tool}`,
    });
    if (!result.ok) {
      throw new Error(`approval failed: ${result.error.code}: ${result.error.message}`);
    }
    return result.data as { token: string; approval_id: string };
  });
}

export async function runApproved(
  tools: PayOpsTools,
  human: RoutedHumanChannel,
  tool: MutationTool,
  business: Record<string, unknown>,
  idempotencyKey: string,
): Promise<import('../../src/tools/registry').ToolResult> {
  const { token } = await requestToken(tools, human, tool, business, idempotencyKey);
  return tools.execute(tool, {
    ...business,
    idempotency_key: idempotencyKey,
    approval_token: token,
  });
}

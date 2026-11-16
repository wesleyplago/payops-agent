/**
 * Drives one real approval -> charge flow through the running compose stack,
 * then exports the resulting trace from Jaeger and the OTLP file exporter.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';
const AGENT_KEY = process.env.COMPOSE_AGENT_KEY ?? 'compose-agent-key-change-me';
const APPROVER_KEY = process.env.COMPOSE_APPROVER_KEY ?? 'compose-approver-secret-change-me';

const idempotencyKey = randomUUID();
const intent = {
  message: 'Create the demo charge after human approval',
  intent: {
    tool: 'create_charge',
    arguments: {
      amount_cents: 12_345,
      currency: 'BRL',
      customer_id: 'cus_demo',
      description: 'trace demo',
    },
    idempotency_key: idempotencyKey,
  },
  documents: [],
};

const execute = fetch(`${BASE}/v1/agent/execute`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${AGENT_KEY}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(intent),
}).then(async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(`agent execute failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
});

let approvalId: string | undefined;
for (let attempt = 0; attempt < 50; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const response = await fetch(`${BASE}/internal/approvals?status=pending`, {
    headers: { 'x-approver-key': APPROVER_KEY },
  });
  const body = (await response.json()) as { approvals: Array<{ id: string; idempotency_key: string }> };
  const match = body.approvals.find((approval) => approval.idempotency_key === idempotencyKey);
  if (match) {
    approvalId = match.id;
    break;
  }
}
if (!approvalId) throw new Error('pending approval not found');

const decision = await fetch(`${BASE}/internal/approvals/${approvalId}/decision`, {
  method: 'POST',
  headers: {
    'x-approver-key': APPROVER_KEY,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ decision: 'approved', decided_by: 'human:demo' }),
});
if (!decision.ok) throw new Error(`approval failed: ${decision.status} ${await decision.text()}`);

const result = (await execute) as {
  trace_id: string;
  status: string;
  data?: { transaction_id: string };
};
const traceId = result.trace_id;
// Give the batch processors time to flush.
await new Promise((resolve) => setTimeout(resolve, 2_500));

let jaeger: unknown;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const response = await fetch(`${BASE.replace(':3000', ':16686')}/api/traces/${traceId}`);
  if (response.ok) {
    const body = (await response.json()) as { data?: unknown[] };
    if (body.data && body.data.length > 0) {
      jaeger = body;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!jaeger) throw new Error('trace not found in Jaeger');

mkdirSync('reports', { recursive: true });
writeFileSync(path.resolve('reports/jaeger-trace.json'), JSON.stringify(jaeger, null, 2) + '\n');
writeFileSync(
  path.resolve('reports/demo-result.json'),
  JSON.stringify({ idempotency_key: idempotencyKey, approval_id: approvalId, trace_id: traceId, result }, null, 2) + '\n',
);
// eslint-disable-next-line no-console
console.log(JSON.stringify({ trace_id: traceId, approval_id: approvalId, status: result.status, transaction_id: result.data?.transaction_id }, null, 2));

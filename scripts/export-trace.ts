/**
 * Exports a trace from a running Jaeger to reports/jaeger-trace.json.
 *
 *   pnpm run trace:export                       # latest payops-agent trace
 *   pnpm run trace:export -- --trace <trace_id>
 *
 * To generate a fresh approval -> charge trace first, use scripts/demo-trace.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const JAEGER = process.env.JAEGER_QUERY_URL ?? 'http://127.0.0.1:16686';
const SERVICE = process.env.OTEL_SERVICE_NAME ?? 'payops-agent';
const traceIdx = process.argv.indexOf('--trace');
const outIdx = process.argv.indexOf('--out');
const out = path.resolve(outIdx !== -1 ? process.argv[outIdx + 1]! : 'reports/jaeger-trace.json');

let traceId = traceIdx !== -1 ? process.argv[traceIdx + 1] : undefined;
if (!traceId) {
  const res = await fetch(`${JAEGER}/api/traces?service=${encodeURIComponent(SERVICE)}&limit=1`);
  if (!res.ok) throw new Error(`Jaeger search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ traceID: string }> };
  traceId = body.data?.[0]?.traceID;
  if (!traceId) throw new Error(`no traces for service "${SERVICE}" in Jaeger`);
}

const res = await fetch(`${JAEGER}/api/traces/${traceId}`);
if (!res.ok) throw new Error(`Jaeger trace fetch failed: HTTP ${res.status}`);
const trace = await res.json();
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(trace, null, 2) + '\n');
// eslint-disable-next-line no-console
console.log(JSON.stringify({ trace_id: traceId, out }, null, 2));

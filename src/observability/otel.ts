import type { AppConfig } from '../config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;

/**
 * OTLP/JSON file exporter. Jaeger receives the same spans over OTLP/HTTP; this
 * exporter keeps an inspectable copy in the repo (reports/otel-trace.json).
 */
class JsonFileSpanExporter implements SpanExporter {
  private readonly traces = new Map<
    string,
    { resource: Json; spans: Map<string, Json> }
  >();

  constructor(private readonly filePath: string) {
    this.loadExisting();
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    try {
      for (const span of spans) {
        const traceId = span.spanContext().traceId;
        const bucket = this.traces.get(traceId) ?? {
          resource: {
            attributes: toAttributes(span.resource.attributes as Record<string, unknown>),
          },
          spans: new Map<string, Json>(),
        };
        bucket.spans.set(span.spanContext().spanId, spanToJson(span));
        this.traces.set(traceId, bucket);
      }
      this.write();
      resultCallback({ code: 0 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('failed to write OTel trace file', err);
      resultCallback({ code: 1 });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private loadExisting(): void {
    try {
      const payload = JSON.parse(readFileSync(this.filePath, 'utf8')) as Json;
      const resourceSpans = (payload.resourceSpans ?? []) as Json[];
      for (const rs of resourceSpans) {
        const scopeSpans = (rs.scopeSpans ?? []) as Json[];
        for (const ss of scopeSpans) {
          const spans = (ss.spans ?? []) as Json[];
          for (const span of spans) {
            const traceId = String(span.traceId);
            const bucket = this.traces.get(traceId) ?? {
              resource: (rs.resource ?? {}) as Json,
              spans: new Map<string, Json>(),
            };
            bucket.spans.set(String(span.spanId), span);
            this.traces.set(traceId, bucket);
          }
        }
      }
    } catch {
      // First run or unreadable file: start empty.
    }
  }

  private write(): void {
    // Health-check traces are noise. Keep only traces that contain a real tool
    // span, and merge them with traces already on disk so an app restart or a
    // health check cannot erase the committed demo trace.
    const resourceSpans = [...this.traces.entries()]
      .filter(([, bucket]) =>
        [...bucket.spans.values()].some((span) =>
          ['tool.create_charge', 'tool.refund', 'tool.send_pix'].includes(
            String(span.name ?? ''),
          ),
        ),
      )
      .map(([, bucket]) => ({
        resource: bucket.resource,
        scopeSpans: [
          {
            scope: { name: 'payops-agent', version: '1.0.0' },
            spans: [...bucket.spans.values()].sort(
              (a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano),
            ),
          },
        ],
      }));

    if (resourceSpans.length === 0) return;
    const payload = { resourceSpans };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }
}

function spanToJson(span: ReadableSpan): Json {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: String(hrTimeToNanos(span.startTime)),
    endTimeUnixNano: String(hrTimeToNanos(span.endTime)),
    attributes: toAttributes(span.attributes as Record<string, unknown>),
    status: {
      code: span.status.code,
      message: span.status.message,
    },
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: String(hrTimeToNanos(event.time)),
      attributes: toAttributes(
        (event.attributes ?? {}) as Record<string, unknown>,
      ),
    })),
  };
}

function hrTimeToNanos(time: [number, number]): bigint {
  return BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
}

function toAttributes(attributes: Record<string, unknown>): Json[] {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function anyValue(value: unknown): Json {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  if (value && typeof value === 'object') {
    return {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(
          ([key, item]) => ({ key, value: anyValue(item) }),
        ),
      },
    };
  }
  return { stringValue: String(value) };
}

export type Telemetry = {
  shutdown: () => Promise<void>;
};

export function startTelemetry(config: AppConfig): Telemetry {
  const processors = [];
  if (config.otelExporterEndpoint) {
    const url = `${config.otelExporterEndpoint.replace(/\/$/, '')}/v1/traces`;
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url,
        }),
      ),
    );
  }
  if (config.otelTraceFile) {
    processors.push(
      new BatchSpanProcessor(new JsonFileSpanExporter(config.otelTraceFile)),
    );
  }

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: config.otelServiceName,
      [ATTR_SERVICE_VERSION]: '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    spanProcessors: processors,
  });
  sdk.start();

  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

import {
  SpanStatusCode,
  context,
  trace,
  type Span,
  type Attributes,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('payops-agent', '1.0.0');

export function currentTraceId(): string | undefined {
  return trace.getSpan(context.active())?.spanContext().traceId;
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

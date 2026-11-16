import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { ZodError } from 'zod';
import type { AppConfig } from './config';
import { AppError, toPublicError } from './domain/errors';
import { AgentRequestSchema, type AgentRuntime } from './agent/runtime';
import type { ApprovalService } from './services/approval';
import type { PayOpsTools } from './tools/registry';
import { currentTraceId, withSpan } from './observability/tracing';

export type AppDependencies = {
  db: Knex;
  config: AppConfig;
  approvals: ApprovalService;
  tools: PayOpsTools;
  agent: AgentRuntime;
};

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = performance.now();
    return withSpan(
      'http.request',
      {
        'http.method': c.req.method,
        'http.route': c.req.path,
      },
      async (span) => {
        c.header('x-trace-id', span.spanContext().traceId);
        await next();
        span.setAttribute('http.status_code', c.res.status);
        span.setAttribute('http.duration_ms', performance.now() - started);
      },
    );
  });

  app.get('/healthz', (c) => c.json({ status: 'ok', trace_id: currentTraceId() }));

  app.get('/readyz', async (c) => {
    try {
      await deps.db.raw('select 1');
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'not_ready' }, 503);
    }
  });

  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const expected = `Bearer ${deps.config.agentApiKey}`;
    if (!secretEquals(auth, expected)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid agent key' } }, 401);
    }
    await next();
  });

  app.post('/v1/agent/execute', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'invalid agent request',
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        400,
      );
    }
    const result = await deps.agent.execute(parsed.data, { source: 'http-agent' });
    return c.json(result);
  });

  app.post('/v1/tools/:tool', async (c) => {
    const tool = c.req.param('tool');
    const body = await c.req.json().catch(() => null);
    const result = await deps.tools.execute(tool, body, { source: 'http-tools' });
    if (result.ok) return c.json(result);
    return c.json(result, statusFor(result.error.code));
  });

  app.get('/internal/approvals', async (c) => {
    if (!approverAuthorized(c.req.header('x-approver-key'), deps.config.approverSecret)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'approver key required' } }, 401);
    }
    const status = c.req.query('status') ?? 'pending';
    const rows = await deps.db('approval_requests')
      .where({ status })
      .orderBy('requested_at', 'asc')
      .limit(50)
      .select(
        'id',
        'tool',
        'arguments',
        'idempotency_key',
        'amount_cents',
        'justification',
        'status',
        'requested_at',
        'expires_at',
      );
    return c.json({ approvals: rows });
  });

  app.post('/internal/approvals/:id/decision', async (c) => {
    if (!approverAuthorized(c.req.header('x-approver-key'), deps.config.approverSecret)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'approver key required' } }, 401);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { decision?: 'approved' | 'denied'; decided_by?: string; reason?: string }
      | null;
    if (!body || (body.decision !== 'approved' && body.decision !== 'denied')) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'decision must be approved or denied' } },
        400,
      );
    }
    await deps.approvals.decide(
      c.req.param('id'),
      body.decision,
      body.decided_by ?? 'human:http',
    );
    return c.json({ approval_id: c.req.param('id'), status: body.decision });
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'route not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'request validation failed',
            details: err.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        400,
      );
    }
    if (err instanceof AppError) {
      return c.json({ error: toPublicError(err) }, err.httpStatus as 400);
    }
    // eslint-disable-next-line no-console
    console.error('unhandled error', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } }, 500);
  });

  return app;
}

function approverAuthorized(provided: string | undefined, secret: string): boolean {
  return Boolean(provided) && secretEquals(provided as string, secret);
}

function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function statusFor(code: string): 400 | 401 | 403 | 404 | 409 | 500 | 502 {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_DENIED':
    case 'APPROVAL_EXPIRED':
    case 'POLICY_VIOLATION':
    case 'TOOL_NOT_ALLOWED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'IDEMPOTENCY_CONFLICT':
    case 'REFUND_EXCEEDS_CAPTURE':
    case 'REFUND_DUPLICATE':
      return 409;
    case 'GATEWAY_ERROR':
      return 502;
    default:
      return 500;
  }
}

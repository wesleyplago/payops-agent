# Incident 002 — agent retry after success asked for a new approval instead of replaying

- **Date:** 2026-11-16
- **Severity:** medium (idempotency contract violation at the agent layer; no duplicate charge)
- **Detected by:** manual use of the interactive console (`pnpm run console`, option 6), not by
  the test suite
- **Status:** fixed and covered by `tests/integration/agent-retry.test.ts`

## What happened

A charge was approved and committed through `POST /v1/agent/execute`. Sending the **same** intent
with the **same** idempotency key again (the "model retries after apparent success" case) returned:

```text
Agente: failed — Ação não executada. Código: UNKNOWN.
tools: request_approval ✘APPROVAL_REQUIRED
```

The ledger was correct (one transaction). But the caller got a failure instead of the original
response, which is the same trap as INCIDENT-001: a client that reads "approval required" may retry
with a **new** key and charge twice.

A second, smaller bug showed up in the same session: every non-completed answer said
`Código: UNKNOWN`, because the runtime never passed the error to the answer composer.

## Why the suite did not catch it

The chaos harness and the idempotency tests retry at the **tool** layer, where the ledger already
replays without a token. Nothing retried through the **agent** runtime, which always called
`request_approval` first. For an already-committed key that request is refused, so the runtime never
reached the ledger's replay path.

## Fix

`src/agent/runtime.ts` now probes the mutation tool **without** a token before asking for approval.
This is safe because the ledger checks the idempotency key before the token:

| state of the key | probe result | runtime does |
| --- | --- | --- |
| committed, same arguments | stored response (`replayed: true`) | returns it; no new approval |
| committed, other arguments | `IDEMPOTENCY_CONFLICT` | fails with that code |
| new | `APPROVAL_REQUIRED`, no rows written | normal approval flow |

Error codes are now passed through to the answer (`APPROVAL_DENIED`, `POLICY_VIOLATION`, ...).

## Verification

- Regression test: written first, failed 3/4 before the fix, passes 4/4 after.
- Full suite 49/49; chaos 1,000 runs: 0 duplicates, 0 invariant violations, 0 orphan outbox;
  injection: 0/120 bounded, 0/120 compromised, 0 PII leaks.

## Lesson

Testing idempotency at one layer does not prove it at the layer above. Every entry point that can
retry needs its own retry test, and using the system by hand still finds what the suite was not
designed to look for.

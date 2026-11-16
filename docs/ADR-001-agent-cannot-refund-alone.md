# ADR 001 — Why the agent cannot refund on its own

- **Status:** accepted
- **Date:** 2026-10-23
- **Deciders:** payments engineering / risk
- **Scope:** every mutating tool (`create_charge`, `refund`, `send_pix`)

## Context

The agent can read balances and invoices, create charges, refund captured charges and send Pix.
A refund and a Pix are irreversible money movements. The model is probabilistic, receives
untrusted text from an internal knowledge base, and can be retried by its own runtime after a
lost response.

The failure we care about is not "the model writes a bad sentence". It is:

> a prompt injection, a confused-deputy request or a retry loop causes the agent to move money
> that no human approved, or moves it twice.

The system already has an idempotency key and a double-entry ledger. Those prevent *duplicate*
postings, but they do not prevent an *authorized-looking* single refund that a human never saw.
Idempotency is not authorization.

## Decision

**The agent can request approval; it can never grant it.**

1. The agent calls the `request_approval` tool with the exact tool name, business arguments and
   idempotency key it intends to use.
2. The request is stored as `pending`. The agent receives no token at this point.
3. A human decides through `POST /internal/approvals/:id/decision`, protected by
   `APPROVER_SECRET` — a credential the agent process does not receive and cannot call as a tool.
4. Only an `approved` decision mints a short-lived token. The raw token is returned once to the
   waiting agent; only its SHA-256 hash is stored.
5. The token is bound to `(tool, args_hash, idempotency_key)`, expires in 60 s by default and is
   single-use.
6. The mutation consumes the token **inside the same SQL transaction** that writes
   `transactions`, `entries` and `outbox`. A rollback also returns the token to unused state.
7. Without a valid token the ledger fails closed with `APPROVAL_REQUIRED`. A replay of an already
   committed idempotency key returns the stored response without asking for a second approval.
8. Refunds have a second, independent bound: the sum of refunds cannot exceed the original capture.
   Even a human who approves an over-refund cannot make the ledger accept it.

```
agent ──request_approval──▶ pending request ──human/approver endpoint──▶ approved
   │                                                                        │
   └──────────────── token (tool+args+key, TTL, single use) ◀──────────────┘
                                   │
                    create_charge/refund/send_pix
                                   │
                 one SQL transaction: tx + entries + outbox
                                   │
                    assertLedgerInvariant() before COMMIT
```

## Why not auto-approve below a threshold?

It sounds convenient and it is exactly the blast radius we are trying to remove. A compromised
model can issue many small refunds; "small" is relative to the attacker, not to the customer.
Threshold-based auto-approval also makes approval fatigue and policy drift invisible. In this
service the only auto-approver is the test double, and it approves **only the exact operator
intent** (tool + arguments + idempotency key). Production defaults to `PendingHumanChannel`.

## Why not let the agent hold the approval signing key?

Then the agent can forge approval. The key would have to be in the same process, prompt or tool
runtime that consumes untrusted documents. That collapses authorization into authentication of
the attacker's text. The approval secret is only on the approver path.

## Consequences

### Positive

- A prompt injection can propose a refund, but cannot approve it.
- A stolen agent API key cannot move money without a human decision.
- The token cannot be reused for a different amount, destination, tool or idempotency key.
- The ledger independently caps refunds at the original capture.
- Every mutation has an audit trail: request, approver, decision time, token consumption, ledger,
  outbox.
- Tests can prove fail-closed behavior by removing the token or forging one.

### Negative / costs

- Human latency on every mutation; the agent long-polls up to `APPROVAL_WAIT_MS`.
- Approval fatigue is a real operational risk. Mitigations are out of scope for this demo:
  queue prioritization, risk scoring that *routes* but does not approve, and periodic review.
- A human can still be socially engineered. The ledger bound and idempotency key limit the damage
  to one exact, bounded action.
- If the process dies after approval but before the agent receives the token, the approval request
  remains approved and the human may need to re-approve. The system never fails open.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Agent calls `refund` directly with a policy check | Policy check is code the compromised agent already influences; no separation of duties |
| Agent signs its own token | Same trust domain; forging is trivial once the agent is compromised |
| Auto-approve all refunds under R$ X | Attacker can split; turns an authorization control into a rate limit |
| Post-hoc human review | Money is already gone; review cannot undo an irreversible Pix |
| UI button inside the same agent process | The agent can click it; not an independent channel |
| Rely on idempotency only | Prevents duplicates, not unauthorized first movements |

## Enforcement points in code

- `src/services/approval.ts` — pending by default, token binding, TTL, single use, consumption.
- `src/ledger/service.ts` — token consumed in the same transaction as the posting; refund bound
  with `SELECT ... FOR UPDATE` on the original capture.
- `src/tools/registry.ts` — allowlist and Zod validation before any handler.
- `src/app.ts` — approver endpoint uses a separate secret; the agent key cannot call it.
- `tests/integration/approval.test.ts` — missing, forged, tampered, expired and reused tokens.
- `tests/integration/refund.test.ts` — over-refund and concurrent partial refunds.
- `tests/injection/injection.test.ts` + `reports/injection-report.json` — forced-compromised
  model still cannot move money or forge approval.

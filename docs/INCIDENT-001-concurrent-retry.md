# Incident 001 — 20 concurrent retries, 1 charge, 19 false `APPROVAL_EXPIRED`

- **Date:** 2026-10-23
- **Severity:** medium (idempotency contract violation; no duplicate charge observed)
- **Detected by:** `tests/integration/ledger-idempotency.test.ts` — "serializes 20 concurrent retries
  into one transaction and one gateway capture"
- **Status:** fixed and covered by a regression test

## What happened

The 20-retry test sends the **same** `create_charge` request, with the **same** idempotency key and
the **same** single-use approval token, 20 times concurrently. The expected result is one ledger
transaction and 20 successful responses: 1 fresh, 19 idempotent replays.

Instead, the test failed. The first request committed one charge, and the other 19 returned:

```text
× serializes 20 concurrent retries into one transaction and one gateway capture
  → expected [ { ok: false, …(2) }, …(18) ] to deeply equal []

  code: APPROVAL_EXPIRED
  message: approval token already used
```

The ledger itself was correct: exactly **one** transaction, **two** entries, **one** outbox row and
**one** gateway capture. The bug was in the **response contract**, not in the money movement.

## Root cause

The mutation path consumed the single-use approval token *before* inserting the row with the unique
`idempotency_key`. Under concurrency:

1. All 20 transactions read the idempotency key and saw no existing transaction.
2. They all tried to consume the same approval token.
3. One won, consumed the token, inserted and committed.
4. The other 19 waited on the token row, then saw `used_at IS NOT NULL` and threw
   `APPROVAL_EXPIRED`.
5. The catch block only mapped a PostgreSQL unique violation (`23505`) to an idempotent replay.
   Authorization errors were rethrown, so a caller whose twin had just succeeded received an error
   instead of the original response.

This is dangerous even though no duplicate was created. A client that treats `APPROVAL_EXPIRED` as
"safe to retry with a new key" can create a second charge. The idempotency contract must survive any
concurrent outcome, not just the unique-constraint race.

## The failing state

Reproduced by temporarily restoring the pre-fix catch block:

```ts
} catch (err) {
  if (isPgUniqueViolation(err)) {
    const winner = await this.db('transactions')
      .where({ idempotency_key: args.idempotency_key })
      .first();
    if (winner) return replay(winner, argsHash);
  }
  throw err;
}
```

Command:

```bash
node ./node_modules/vitest/vitest.mjs run tests/integration/ledger-idempotency.test.ts \
  -t 'serializes 20 concurrent retries'
```

Result: `1 failed | 3 skipped`, with 19 `APPROVAL_EXPIRED` failures and one committed transaction.
The log is reproduced verbatim in the failure output above.

## Fix

After **any** error and rollback, re-read the idempotency key. If a transaction with that key exists
and its request hash matches, return its stored response. If the hash differs, return
`IDEMPOTENCY_CONFLICT`. Only if no transaction exists rethrow the original error.

```ts
} catch (err) {
  // A concurrent request with the same key may have won the race — including
  // the case where it consumed the single-use approval token first.
  const winner = await this.db('transactions')
    .where({ idempotency_key: args.idempotency_key })
    .first();
  if (winner) return replay(winner, argsHash);
  throw err;
}
```

The token is still consumed exactly once, inside the winning SQL transaction. The losers do not
get a new token, do not touch the gateway and do not insert anything. They simply read the winner's
committed response.

## Regression test

`tests/integration/ledger-idempotency.test.ts` asserts:

- all 20 results are `ok: true`;
- exactly one result has `replayed: false`;
- exactly one `transactions` row, two `entries`, one `outbox` row;
- the simulated gateway received exactly one capture for that key;
- the ledger invariant is clean.

Current result: pass in ~100 ms. The same file also covers replay without a token and key reuse with
different arguments.

## What this incident taught us

1. Idempotency is a **response** guarantee, not only a database uniqueness constraint.
2. Single-use authorization primitives create a new race that must be reconciled with idempotency.
3. Concurrency tests must assert the response distribution, not just the final row count.
4. A failure that does not duplicate money can still push callers into a duplicate-charge path.

## Related

- `docs/ADR-001-agent-cannot-refund-alone.md`
- `src/ledger/service.ts` — `mutate()` catch and `replay()`
- `reports/chaos-report.json` — the 1,000-run suite includes this race as
  `retry_after_success` and `timeout_at_2s` scenarios.

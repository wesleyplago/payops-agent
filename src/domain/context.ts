export type FaultPlan = {
  /** A client-side timeout at t+2s: the operation may still commit. */
  clientTimeoutMs?: number;
  /** Gateway returns HTTP 500 before the ledger transaction commits. */
  gateway500BeforeCommit?: boolean;
  /** Gateway committed, then the response is lost (HTTP 500 after commit). */
  gateway500AfterCommit?: boolean;
  /** The process dies mid-transaction: Postgres must roll back everything. */
  crashBeforeCommit?: boolean;
  /** The process dies after COMMIT: retry must replay instead of re-charging. */
  crashAfterCommit?: boolean;
  /** Duplicate the outbox webhook at least once. */
  duplicateWebhook?: boolean;
  /** Extra synthetic latency before the operation starts (ms). */
  latencyMs?: number;
  /** Hold the open SQL transaction after entries are written (real-kill test). */
  pauseBeforeCommitMs?: number;
};

export type ToolContext = {
  source?: string;
  faults?: FaultPlan;
  /** Used for the subset of tests that must assert trace linkage. */
  traceId?: string;
};

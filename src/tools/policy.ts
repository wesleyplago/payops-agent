import { AppError } from '../domain/errors';
import type { AppConfig } from '../config';
import type { MutationTool } from './schemas';
import { containsPii } from '../domain/pii';

export const IMMUTABLE_POLICY = {
  maxAmountCents: 100_000_00,
  sendPixAllowlist: [] as readonly string[],
  refundsRequireOriginalCapture: true,
  humanApprovalRequired: true,
} as const;

/**
 * Deny by default: a tool absent from this list cannot be invoked, and a
 * business argument outside policy is rejected before an approval is requested.
 * Injected text can describe a new policy; it cannot install one.
 */
export function assertBusinessPolicy(
  tool: MutationTool,
  args: {
    amount_cents: number;
    pix_key?: string;
    description?: string;
    reason?: string;
    customer_id?: string;
  },
  config: AppConfig,
): void {
  if (!Number.isSafeInteger(args.amount_cents) || args.amount_cents <= 0) {
    throw new AppError('VALIDATION_ERROR', 'amount_cents must be positive', 400);
  }
  if (args.amount_cents > IMMUTABLE_POLICY.maxAmountCents) {
    throw new AppError('POLICY_VIOLATION', 'amount exceeds immutable policy ceiling', 403, {
      max_amount_cents: IMMUTABLE_POLICY.maxAmountCents,
    });
  }
  // Argument-level DLP: free-text fields must not become an exfiltration
  // channel toward the ledger, the outbox or a downstream webhook.
  for (const field of ['description', 'reason'] as const) {
    const value = args[field];
    if (typeof value === 'string' && containsPii(value)) {
      throw new AppError(
        'POLICY_VIOLATION',
        `${field} contains PII and cannot be persisted or sent`,
        403,
        { field, rule: 'pii_in_free_text' },
      );
    }
  }
  if (args.customer_id && !/^cus_[a-z0-9_]{1,40}$/i.test(args.customer_id)) {
    throw new AppError(
      'POLICY_VIOLATION',
      'customer_id is not an opaque internal identifier',
      403,
      { field: 'customer_id', rule: 'opaque_identifier_only' },
    );
  }
  if (tool === 'send_pix') {
    if (!args.pix_key || !config.sendPixAllowlist.includes(args.pix_key)) {
      throw new AppError(
        'POLICY_VIOLATION',
        'pix key is not in the immutable destination allowlist',
        403,
        { pix_key: args.pix_key },
      );
    }
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { HumanApprovalChannel, ApprovalRequestView } from '../services/approval';
import { canonicalJson } from '../domain/ids';
import { businessSchemas, type MutationTool } from '../tools/schemas';

export type ExpectedAction = {
  tool: MutationTool;
  arguments: Record<string, unknown>;
  idempotency_key: string;
};

/**
 * Simulated human reviewer. It approves only the exact action the operator
 * intended. This is the test double for the out-of-band human; the server uses
 * the pending channel and the protected decision endpoint.
 */
export class RoutedHumanChannel implements HumanApprovalChannel {
  readonly name = 'human:routed-test';
  readonly storage = new AsyncLocalStorage<ExpectedAction | null>();
  readonly reviews: Array<{ tool: string; approved: boolean; reason: string }> = [];

  async review(request: ApprovalRequestView): Promise<'approved' | 'denied'> {
    const expected = this.storage.getStore();
    if (!expected) {
      this.reviews.push({ tool: request.tool, approved: false, reason: 'no expected action' });
      return 'denied';
    }
    const business = businessSchemas[expected.tool].parse(expected.arguments);
    const matches =
      request.tool === expected.tool &&
      request.idempotency_key === expected.idempotency_key &&
      canonicalJson(request.arguments) === canonicalJson(business);
    this.reviews.push({
      tool: request.tool,
      approved: matches,
      reason: matches ? 'matches operator intent' : 'does not match operator intent',
    });
    return matches ? 'approved' : 'denied';
  }
}

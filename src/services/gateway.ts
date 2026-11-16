import { AppError } from '../domain/errors';
import type { FaultPlan } from '../domain/context';

export type GatewayReceipt = {
  provider_ref: string;
  operation: string;
  idempotency_key: string;
  deduplicated: boolean;
};

export interface GatewayPort {
  capture(input: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    customerId: string;
    faults?: FaultPlan;
  }): Promise<GatewayReceipt>;
  refund(input: {
    idempotencyKey: string;
    amountCents: number;
    chargeId: string;
    faults?: FaultPlan;
  }): Promise<GatewayReceipt>;
  sendPix(input: {
    idempotencyKey: string;
    amountCents: number;
    pixKey: string;
    faults?: FaultPlan;
  }): Promise<GatewayReceipt>;
}

/**
 * Simulated gateway. The contract is what matters: every operation receives the
 * caller's idempotency key and must return the same provider_ref on retry.
 * This is how the real gateway prevents a second capture when a response is lost.
 */
export class SimulatedGateway implements GatewayPort {
  private readonly receipts = new Map<string, GatewayReceipt>();
  readonly stats = { calls: 0, deduplicated: 0, failures: 0 };

  async capture(input: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    customerId: string;
    faults?: FaultPlan;
  }): Promise<GatewayReceipt> {
    return this.run('capture', input.idempotencyKey, input.faults, {
      amountCents: input.amountCents,
      customerId: input.customerId,
      currency: input.currency,
    });
  }

  async refund(input: {
    idempotencyKey: string;
    amountCents: number;
    chargeId: string;
    faults?: FaultPlan;
  }): Promise<GatewayReceipt> {
    return this.run('refund', input.idempotencyKey, input.faults, {
      amountCents: input.amountCents,
      chargeId: input.chargeId,
    });
  }

  async sendPix(input: {
    idempotencyKey: string;
    amountCents: number;
    pixKey: string;
    faults?: FaultPlan;
  }): Promise<GatewayReceipt> {
    return this.run('send_pix', input.idempotencyKey, input.faults, {
      amountCents: input.amountCents,
      pixKey: input.pixKey,
    });
  }

  private async run(
    operation: string,
    idempotencyKey: string,
    faults: FaultPlan | undefined,
    _payload: Record<string, unknown>,
  ): Promise<GatewayReceipt> {
    this.stats.calls += 1;
    if (faults?.gateway500BeforeCommit) {
      this.stats.failures += 1;
      throw new AppError('GATEWAY_ERROR', 'simulated gateway HTTP 500', 502, {
        operation,
        phase: 'before_commit',
      });
    }

    const key = `${operation}:${idempotencyKey}`;
    const existing = this.receipts.get(key);
    if (existing) {
      this.stats.deduplicated += 1;
      return { ...existing, deduplicated: true };
    }

    const receipt: GatewayReceipt = {
      provider_ref: `sim_${operation}_${this.receipts.size + 1}`,
      operation,
      idempotency_key: idempotencyKey,
      deduplicated: false,
    };
    this.receipts.set(key, receipt);
    return receipt;
  }

  resetStats(): void {
    this.stats.calls = 0;
    this.stats.deduplicated = 0;
    this.stats.failures = 0;
  }
}
